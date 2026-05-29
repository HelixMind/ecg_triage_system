"""
HelixMind Wearable Triage — Model definitions
Extracted from ecg_wearable_triage.ipynb
"""

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from scipy import signal as scipy_signal
from scipy.signal import resample_poly
from math import gcd
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Tuple
from enum import Enum
from datetime import datetime

# ── Signal parameters ─────────────────────────────────────────────────────────
ECG_FS        = 256
PPG_FS        = 64
WINDOW_SEC    = 30
ECG_LEN       = ECG_FS * WINDOW_SEC   # 7680
PPG_LEN       = PPG_FS * WINDOW_SEC   # 1920

RHYTHM_CLASSES = ['Normal', 'AFib', 'Bradycardia', 'Tachycardia', 'Anomaly']
N_RHYTHM       = len(RHYTHM_CLASSES)
STRESS_CLASSES = ['Low', 'Medium', 'High']

HR_CRITICAL_LOW   = 40
HR_CRITICAL_HIGH  = 150
SPO2_CRIT_THRESH  = 90.0
SPO2_WARN_THRESH  = 95.0
HRV_LOW_THRESH    = 20.0
YELLOW_THRESH     = 0.40
RED_THRESH        = 0.72

CONFIDENCE_PROFILES = {
    'ecg_and_ppg': (1.00, RED_THRESH,        'Full capability'),
    'ecg_only':    (0.80, RED_THRESH - 0.08, 'No PPG — SpO2/stress limited'),
    'ppg_only':    (0.65, RED_THRESH - 0.15, 'No ECG — morphology limited'),
}

DEVICE_PROFILES = {
    'apple_watch':       {'ecg_fs': 512,  'ppg_fs': 100, 'has_ecg': True,  'has_ppg': True},
    'samsung_galaxy':    {'ecg_fs': 200,  'ppg_fs': 100, 'has_ecg': True,  'has_ppg': True},
    'fitbit_sense':      {'ecg_fs': 256,  'ppg_fs': 128, 'has_ecg': True,  'has_ppg': True},
    'fitbit_charge':     {'ecg_fs': None, 'ppg_fs': 128, 'has_ecg': False, 'has_ppg': True},
    'garmin_venu':       {'ecg_fs': 256,  'ppg_fs': 25,  'has_ecg': True,  'has_ppg': True},
    'kardia_mobile':     {'ecg_fs': 300,  'ppg_fs': None,'has_ecg': True,  'has_ppg': False},
    'smartphone_camera': {'ecg_fs': None, 'ppg_fs': 30,  'has_ecg': False, 'has_ppg': True},
    'generic_wearable':  {'ecg_fs': 256,  'ppg_fs': 64,  'has_ecg': True,  'has_ppg': True},
}


# ── Severity types ────────────────────────────────────────────────────────────

class Severity(Enum):
    GREEN  = 'GREEN'
    YELLOW = 'YELLOW'
    RED    = 'RED'


@dataclass
class TriageResult:
    timestamp:           str
    severity:            Severity
    severity_score:      float
    rhythm_label:        str
    rhythm_probs:        Dict[str, float]
    heart_rate:          float
    hrv_rmssd:           float
    spo2:                float
    stress_level:        str
    stress_probs:        Dict[str, float]
    requires_escalation: bool = False
    escalation_reason:   str  = ''
    gps_location:        Optional[Tuple[float, float]] = None

    def to_dict(self):
        return {
            'timestamp':           self.timestamp,
            'severity':            self.severity.value,
            'severity_score':      round(float(self.severity_score), 4),
            'rhythm_label':        self.rhythm_label,
            'rhythm_probs':        self.rhythm_probs,
            'heart_rate':          round(float(self.heart_rate), 1),
            'hrv_rmssd':           round(float(self.hrv_rmssd), 1),
            'spo2':                round(float(self.spo2), 1),
            'stress_level':        self.stress_level,
            'stress_probs':        self.stress_probs,
            'requires_escalation': self.requires_escalation,
            'escalation_reason':   self.escalation_reason,
        }


# ── Preprocessing ─────────────────────────────────────────────────────────────

class ECGPreprocessor:
    def __init__(self, fs: int = ECG_FS):
        self.fs  = fs
        self.sos = scipy_signal.butter(4, [0.5, 40.0], btype='bandpass', fs=fs, output='sos')

    def __call__(self, ecg: np.ndarray) -> np.ndarray:
        ecg = np.nan_to_num(ecg.astype(np.float32))
        ecg = scipy_signal.sosfiltfilt(self.sos, ecg)
        mu, std = ecg.mean(), ecg.std() + 1e-8
        ecg = np.clip(ecg, mu - 5*std, mu + 5*std)
        return (ecg - mu) / std


class PPGPreprocessor:
    def __init__(self, fs: int = PPG_FS):
        self.fs  = fs
        self.sos = scipy_signal.butter(4, [0.5, 8.0], btype='bandpass', fs=fs, output='sos')

    def __call__(self, ppg: np.ndarray) -> np.ndarray:
        ppg = np.nan_to_num(ppg.astype(np.float32))
        ppg = scipy_signal.sosfiltfilt(self.sos, ppg)
        mu, std = ppg.mean(), ppg.std() + 1e-8
        return (ppg - mu) / std


class FeatureExtractor:
    def __init__(self, ecg_fs: int = ECG_FS, ppg_fs: int = PPG_FS):
        self.ecg_fs = ecg_fs
        self.ppg_fs = ppg_fs

    def extract_hr_from_ppg(self, ppg: np.ndarray) -> float:
        peaks, _ = scipy_signal.find_peaks(ppg, distance=int(self.ppg_fs * 0.4), height=0.3)
        if len(peaks) < 2:
            return 75.0
        rr = np.diff(peaks) / self.ppg_fs
        return float(60.0 / np.median(rr))

    def extract_hrv_rmssd(self, ppg: np.ndarray) -> float:
        peaks, _ = scipy_signal.find_peaks(ppg, distance=int(self.ppg_fs * 0.4), height=0.3)
        if len(peaks) < 3:
            return 30.0
        rr_ms = np.diff(peaks) / self.ppg_fs * 1000
        return float(np.sqrt(np.mean(np.diff(rr_ms)**2)))

    def estimate_spo2(self, ppg: np.ndarray) -> float:
        ac   = ppg.std()
        dc   = np.abs(ppg.mean()) + 1e-8
        r    = ac / dc
        return float(np.clip(110.0 - 25.0 * r, 85.0, 100.0))

    def extract_all(self, ecg: np.ndarray, ppg: np.ndarray) -> dict:
        return {
            'heart_rate': self.extract_hr_from_ppg(ppg),
            'hrv_rmssd':  self.extract_hrv_rmssd(ppg),
            'spo2':       self.estimate_spo2(ppg),
        }


# ── Universal input adapter ───────────────────────────────────────────────────

class UniversalInputAdapter:
    TARGET_ECG_FS  = ECG_FS
    TARGET_PPG_FS  = PPG_FS
    TARGET_ECG_LEN = ECG_LEN
    TARGET_PPG_LEN = PPG_LEN

    def __init__(self, device_name: str = 'generic_wearable'):
        if device_name not in DEVICE_PROFILES:
            raise ValueError(f'Unknown device: {device_name}')
        self.profile     = DEVICE_PROFILES[device_name]
        self.device_name = device_name
        self._ecg_prep   = ECGPreprocessor()
        self._ppg_prep   = PPGPreprocessor()

    def _rational_resample(self, sig, src_fs, tgt_fs):
        if src_fs == tgt_fs:
            return sig
        g    = gcd(src_fs, tgt_fs)
        up   = tgt_fs // g
        down = src_fs // g
        return resample_poly(sig, up, down).astype(np.float32)

    def _fit_length(self, sig, target_len):
        L = len(sig)
        if L == target_len:
            return sig
        if L > target_len:
            start = (L - target_len) // 2
            return sig[start:start + target_len]
        pad_total = target_len - L
        return np.pad(sig, (pad_total // 2, pad_total - pad_total // 2), mode='constant')

    def _check_quality(self, sig, name):
        if np.all(np.isnan(sig)):
            return False, f'{name}: all NaN'
        if sig.std() < 1e-6:
            return False, f'{name}: flat line'
        if np.mean(np.abs(sig) > 4.5 * sig.std()) > 0.15:
            return False, f'{name}: >15% clipped'
        return True, 'ok'

    def adapt(self, ecg_raw=None, ppg_raw=None):
        result  = {'device': self.device_name, 'quality_flags': {}}
        has_ecg = self.profile['has_ecg'] and ecg_raw is not None
        has_ppg = self.profile['has_ppg'] and ppg_raw is not None

        if has_ecg:
            ok, msg = self._check_quality(ecg_raw, 'ECG')
            result['quality_flags']['ecg'] = msg
            if ok:
                ecg = self._rational_resample(ecg_raw, self.profile['ecg_fs'], self.TARGET_ECG_FS)
                ecg = self._fit_length(ecg, self.TARGET_ECG_LEN)
                ecg = self._ecg_prep(ecg)
            else:
                ecg = np.zeros(self.TARGET_ECG_LEN, dtype=np.float32)
                has_ecg = False
        else:
            ecg = np.zeros(self.TARGET_ECG_LEN, dtype=np.float32)
            result['quality_flags']['ecg'] = 'not available'

        if has_ppg:
            ok, msg = self._check_quality(ppg_raw, 'PPG')
            result['quality_flags']['ppg'] = msg
            if ok:
                ppg = self._rational_resample(ppg_raw, self.profile['ppg_fs'], self.TARGET_PPG_FS)
                ppg = self._fit_length(ppg, self.TARGET_PPG_LEN)
                ppg = self._ppg_prep(ppg)
            else:
                ppg = np.zeros(self.TARGET_PPG_LEN, dtype=np.float32)
                has_ppg = False
        else:
            ppg = np.zeros(self.TARGET_PPG_LEN, dtype=np.float32)
            result['quality_flags']['ppg'] = 'not available'

        result.update({'ecg': ecg, 'ppg': ppg, 'has_ecg': has_ecg, 'has_ppg': has_ppg})
        return result


# ── Model architecture ────────────────────────────────────────────────────────

class DepthwiseSeparableConv(nn.Module):
    def __init__(self, in_ch, out_ch, kernel_size=7, stride=1):
        super().__init__()
        pad      = kernel_size // 2
        self.dw  = nn.Conv1d(in_ch, in_ch, kernel_size, stride=stride, padding=pad, groups=in_ch, bias=False)
        self.pw  = nn.Conv1d(in_ch, out_ch, 1, bias=False)
        self.bn  = nn.BatchNorm1d(out_ch)

    def forward(self, x):
        return F.relu(self.bn(self.pw(self.dw(x))), inplace=True)


class LightResBlock(nn.Module):
    def __init__(self, channels, kernel_size=7, dropout=0.1):
        super().__init__()
        self.conv1 = DepthwiseSeparableConv(channels, channels, kernel_size)
        self.conv2 = DepthwiseSeparableConv(channels, channels, kernel_size)
        self.drop  = nn.Dropout(dropout)

    def forward(self, x):
        return x + self.drop(self.conv2(self.conv1(x)))


class SignalEncoder(nn.Module):
    def __init__(self, in_len: int, out_dim: int = 128, dropout: float = 0.1):
        super().__init__()
        self.encoder = nn.Sequential(
            nn.Conv1d(1, 16, kernel_size=7, padding=3, bias=False),
            nn.BatchNorm1d(16),
            nn.ReLU(inplace=True),
            nn.MaxPool1d(4),
            DepthwiseSeparableConv(16, 32, stride=2),
            LightResBlock(32, dropout=dropout),
            DepthwiseSeparableConv(32, 64, stride=2),
            LightResBlock(64, dropout=dropout),
            DepthwiseSeparableConv(64, out_dim, stride=2),
            LightResBlock(out_dim, dropout=dropout),
            nn.AdaptiveAvgPool1d(16),
        )

    def forward(self, x):
        return self.encoder(x)


class WearableTriageModel(nn.Module):
    def __init__(self, dropout: float = 0.2):
        super().__init__()
        FEAT_DIM = 128
        self.ecg_encoder = SignalEncoder(ECG_LEN, out_dim=FEAT_DIM, dropout=dropout)
        self.ppg_encoder = SignalEncoder(PPG_LEN, out_dim=FEAT_DIM, dropout=dropout)
        self.fusion = nn.Sequential(
            nn.Conv1d(FEAT_DIM * 2, FEAT_DIM, kernel_size=1, bias=False),
            nn.BatchNorm1d(FEAT_DIM),
            nn.ReLU(inplace=True),
        )
        self.bilstm    = nn.LSTM(FEAT_DIM, 64, num_layers=1, batch_first=True, bidirectional=True)
        self.lstm_drop = nn.Dropout(dropout)

        def head(out):
            return nn.Sequential(nn.Linear(128, 64), nn.ReLU(inplace=True), nn.Dropout(dropout), nn.Linear(64, out))

        self.rhythm_head   = head(N_RHYTHM)
        self.stress_head   = head(3)
        self.spo2_head     = head(1)
        self.severity_head = head(1)

    def forward(self, ecg, ppg):
        ecg_f  = self.ecg_encoder(ecg)
        ppg_f  = self.ppg_encoder(ppg)
        fused  = self.fusion(torch.cat([ecg_f, ppg_f], dim=1))
        _, (hn, _) = self.bilstm(fused.permute(0, 2, 1))
        ctx    = self.lstm_drop(torch.cat([hn[0], hn[1]], dim=1))
        return {
            'rhythm_logits':  self.rhythm_head(ctx),
            'stress_logits':  self.stress_head(ctx),
            'spo2_pred':      torch.sigmoid(self.spo2_head(ctx)) * 15 + 85,
            'severity_score': torch.sigmoid(self.severity_head(ctx)),
        }


# ── Inference engine ──────────────────────────────────────────────────────────

_ecg_prep = ECGPreprocessor()
_ppg_prep = PPGPreprocessor()
_feat_ext = FeatureExtractor()


def get_confidence_profile(has_ecg: bool, has_ppg: bool) -> dict:
    key = 'ecg_and_ppg' if has_ecg and has_ppg else ('ecg_only' if has_ecg else 'ppg_only')
    conf, thresh, note = CONFIDENCE_PROFILES[key]
    return {'confidence': conf, 'red_threshold': thresh, 'note': note, 'modality': key}


class UniversalSeverityEngine:
    def __init__(self, model: nn.Module, device: str = 'cpu'):
        self.model  = model
        self.device = device
        self.model.eval()

    @torch.no_grad()
    def evaluate(self, adapter_output: dict, gps=None) -> TriageResult:
        ecg     = adapter_output['ecg']
        ppg     = adapter_output['ppg']
        has_ecg = adapter_output['has_ecg']
        has_ppg = adapter_output['has_ppg']

        conf    = get_confidence_profile(has_ecg, has_ppg)
        red_thr = conf['red_threshold']

        if has_ppg:
            vitals = _feat_ext.extract_all(ecg, ppg)
        else:
            peaks, _ = scipy_signal.find_peaks(ecg, distance=int(ECG_FS * 0.4))
            hr = float(60.0 / np.median(np.diff(peaks) / ECG_FS)) if len(peaks) > 2 else 75.0
            vitals = {'heart_rate': hr, 'hrv_rmssd': 30.0, 'spo2': 97.0}

        ecg_t = torch.FloatTensor(ecg).unsqueeze(0).unsqueeze(0).to(self.device)
        ppg_t = torch.FloatTensor(ppg).unsqueeze(0).unsqueeze(0).to(self.device)
        out   = self.model(ecg_t, ppg_t)

        rhythm_probs   = F.softmax(out['rhythm_logits'], dim=1).cpu().numpy()[0]
        stress_probs   = F.softmax(out['stress_logits'], dim=1).cpu().numpy()[0]
        spo2_pred      = out['spo2_pred'].cpu().item()
        severity_score = out['severity_score'].cpu().item()

        adj_score    = float(np.clip(severity_score / conf['confidence'], 0.0, 1.0))
        rhythm_label = RHYTHM_CLASSES[int(rhythm_probs.argmax())]
        stress_label = STRESS_CLASSES[int(stress_probs.argmax())]
        blended_spo2 = (0.6 * spo2_pred + 0.4 * vitals['spo2']) if has_ppg else vitals['spo2']
        vitals['spo2'] = blended_spo2

        severity, reason = self._classify(adj_score, vitals, rhythm_label, red_thr)

        return TriageResult(
            timestamp           = datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            severity            = severity,
            severity_score      = adj_score,
            rhythm_label        = rhythm_label,
            rhythm_probs        = {c: float(f'{p:.4f}') for c, p in zip(RHYTHM_CLASSES, rhythm_probs)},
            heart_rate          = vitals['heart_rate'],
            hrv_rmssd           = vitals['hrv_rmssd'],
            spo2                = blended_spo2,
            stress_level        = stress_label,
            stress_probs        = {c: float(f'{p:.4f}') for c, p in zip(STRESS_CLASSES, stress_probs)},
            requires_escalation = (severity == Severity.RED),
            escalation_reason   = reason,
            gps_location        = gps,
        )

    def _classify(self, score, vitals, rhythm, red_thr):
        if vitals['heart_rate'] < HR_CRITICAL_LOW:
            return Severity.RED, f'Critical bradycardia: {vitals["heart_rate"]:.0f} bpm'
        if vitals['heart_rate'] > HR_CRITICAL_HIGH:
            return Severity.RED, f'Critical tachycardia: {vitals["heart_rate"]:.0f} bpm'
        if vitals['spo2'] < SPO2_CRIT_THRESH:
            return Severity.RED, f'Critical hypoxia: SpO2 {vitals["spo2"]:.1f}%'
        if rhythm == 'AFib' and score > 0.6:
            return Severity.RED, 'High-confidence AFib detected'
        if score >= red_thr:
            return Severity.RED, f'Severity score {score:.2f}'
        if score >= YELLOW_THRESH:
            return Severity.YELLOW, f'{rhythm} · Score {score:.2f}'
        return Severity.GREEN, ''


def load_engine(checkpoint_path: Optional[str] = None, device: str = 'cpu') -> UniversalSeverityEngine:
    """
    Load or initialise the triage engine.
    If checkpoint_path is given, loads trained weights.
    Otherwise initialises with random weights (for demo/testing).
    """
    model = WearableTriageModel().to(device)
    if checkpoint_path:
        ckpt = torch.load(checkpoint_path, map_location=device)
        state = ckpt.get('model_state_dict', ckpt)
        model.load_state_dict(state)
        print(f'Loaded checkpoint: {checkpoint_path}')
    else:
        print('No checkpoint — using random weights (demo mode)')
    model.eval()
    return UniversalSeverityEngine(model, device=device)
