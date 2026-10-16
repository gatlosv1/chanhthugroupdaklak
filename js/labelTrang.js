import { db as firebaseDb } from './firebase.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const textInput = document.getElementById('labelTextInput');
const fontSelect = document.getElementById('fontSelect');
const fontSizeInput = document.getElementById('fontSizeInput');
const colorInput = document.getElementById('textColorInput');
const colorTextLabel = document.getElementById('colorTextLabel');
const labelContent = document.getElementById('labelContent');
const printBtn = document.getElementById('printBtn');
const downloadPdfBtn = document.getElementById('downloadPdfBtn');
const pdfQuantityInput = document.getElementById('pdfQuantity');
const boldBtn = document.getElementById('boldBtn');
const italicBtn = document.getElementById('italicBtn');
const underlineBtn = document.getElementById('underlineBtn');
const alignBtn = document.getElementById('alignBtn');
const configNameInput = document.getElementById('configNameInput');
const configSequenceInput = document.getElementById('configSequenceInput');
const savedConfigSelect = document.getElementById('savedConfigSelect');
const saveConfigBtn = document.getElementById('saveConfigBtn');

const state = {
  text: 'A',
  fontFamily: 'Calibri',
  fontSize: 12,
  color: '#111827',
  bold: false,
  italic: false,
  underline: false,
  align: 'center',
  savedConfigs: [],
  selectedPresetName: '',
  lastPrintedNumber: 0
};

const MAX_FONT_SIZE = 500;
const LABEL_WIDTH_PX = 900;
const LABEL_HEIGHT_PX = 600;
const MIN_AUTO_FIT_SIZE = 10;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const getPrintQuantity = (value) => clamp(Number(value) || 1, 1, 500);
const SETTINGS_DOC = 'labelWhiteSettings';
const PRESET_DOC = 'labelWhiteConfigs';
const LOCAL_PRESET_KEY = 'labelWhiteSavedConfigs';
const LOCAL_LAST_PRINT_KEY = 'labelWhiteLastPrint';

function buildCanvasFont(fontFamily, size, bold, italic) {
  return `${italic ? 'italic' : 'normal'} ${bold ? '700' : '400'} ${size}px ${fontFamily}`;
}

function getTextLayoutMetrics(text, fontFamily, size, bold, italic) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = buildCanvasFont(fontFamily, size, bold, italic);

  const lines = String(text || ' ').replace(/\r/g, '').split('\n');
  const widths = lines.map((line) => ctx.measureText(line || ' ').width);
  const maxLineWidth = Math.max(...widths, 0);
  const totalHeight = lines.length * size * 1.12;

  return {
    lines,
    maxLineWidth,
    totalHeight,
    lineCount: lines.length
  };
}

function getAutoFitFontSize(text, fontFamily, preferredSize, bold = false, italic = false) {
  const normalizedText = String(text ?? '').replace(/\r/g, '') || ' ';
  const safePreferred = clamp(Number(preferredSize) || 12, 10, MAX_FONT_SIZE);

  let low = MIN_AUTO_FIT_SIZE;
  let high = safePreferred;
  let best = safePreferred;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const metrics = getTextLayoutMetrics(normalizedText, fontFamily, mid, bold, italic);
    const fits = metrics.maxLineWidth <= LABEL_WIDTH_PX * 0.82 && metrics.totalHeight <= LABEL_HEIGHT_PX * 0.8;

    if (fits) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return clamp(best, MIN_AUTO_FIT_SIZE, MAX_FONT_SIZE);
}

function readLocalPresets() {
  try {
    const raw = localStorage.getItem(LOCAL_PRESET_KEY);
    const parsed = raw ? JSON.parse(raw) : { presets: [] };
    const presets = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.presets) ? parsed.presets : []);
    return presets.map((preset) => getPresetFromConfig(preset.name || 'Mặc định', preset));
  } catch (error) {
    return [];
  }
}

function writeLocalPresets(presets, selectedName) {
  try {
    localStorage.setItem(LOCAL_PRESET_KEY, JSON.stringify({
      presets: presets.map((preset) => ({
        name: preset.name,
        text: preset.text || '',
        fontFamily: preset.fontFamily || 'Calibri',
        fontSize: clamp(Number(preset.fontSize) || 12, 6, MAX_FONT_SIZE),
        color: preset.color || '#111827',
        bold: Boolean(preset.bold),
        italic: Boolean(preset.italic),
        underline: Boolean(preset.underline),
        align: preset.align || 'center',
        lastPrintedNumber: Number(preset.lastPrintedNumber || 0)
      })),
      selectedPreset: selectedName || presets[0]?.name || ''
    }));
  } catch (error) {
    console.warn('Unable to write local preset storage:', error);
  }
}

function getCurrentConfig() {
  return {
    text: textInput.value || '',
    fontFamily: fontSelect.value,
    fontSize: clamp(Number(fontSizeInput.value) || 12, 6, MAX_FONT_SIZE),
    color: colorInput.value || '#111827',
    bold: state.bold,
    italic: state.italic,
    underline: state.underline,
    align: state.align
  };
}

function getPresetFromConfig(name, config) {
  return {
    name,
    text: config.text || '',
    fontFamily: config.fontFamily || 'Calibri',
    fontSize: clamp(Number(config.fontSize) || 12, 6, MAX_FONT_SIZE),
    color: config.color || '#111827',
    bold: Boolean(config.bold),
    italic: Boolean(config.italic),
    underline: Boolean(config.underline),
    align: config.align || 'center',
    lastPrintedNumber: Number(config.lastPrintedNumber || 0)
  };
}

function populateSavedConfigs(selectedName = state.selectedPresetName || '') {
  const presets = state.savedConfigs || [];
  const currentValue = selectedName || '';

  savedConfigSelect.innerHTML = '<option value="">-- Chọn cấu hình --</option>';

  presets.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.name;
    option.textContent = preset.name;
    if (preset.name === currentValue) {
      option.selected = true;
    }
    savedConfigSelect.appendChild(option);
  });

  if (!presets.some((preset) => preset.name === currentValue) && currentValue) {
    savedConfigSelect.value = '';
  }
}

async function savePresetList(presets, selectedName) {
  const payload = {
    presets: presets.map((preset) => ({
      name: preset.name,
      text: preset.text || '',
      fontFamily: preset.fontFamily || 'Calibri',
      fontSize: clamp(Number(preset.fontSize) || 12, 6, MAX_FONT_SIZE),
      color: preset.color || '#111827',
      bold: Boolean(preset.bold),
      italic: Boolean(preset.italic),
      underline: Boolean(preset.underline),
      align: preset.align || 'center',
      lastPrintedNumber: Number(preset.lastPrintedNumber || 0)
    })),
    selectedPreset: selectedName || presets[0]?.name || '',
    updatedAt: Date.now()
  };

  writeLocalPresets(presets, selectedName || presets[0]?.name || '');

  if (!firebaseDb) return;

  try {
    await setDoc(doc(firebaseDb, 'settings', PRESET_DOC), payload, { merge: true });
  } catch (error) {
    console.error('Failed to save preset list:', error);
  }
}

async function saveCurrentPreset() {
  const name = (configNameInput.value || '').trim();
  if (!name) {
    configNameInput.focus();
    return;
  }

  const config = getCurrentConfig();
  const sequenceValue = clamp(Number(configSequenceInput.value) || 0, 0, 999999);
  configSequenceInput.value = sequenceValue;

  const presets = [...(state.savedConfigs || [])];
  const existingIndex = presets.findIndex((preset) => preset.name.toLowerCase() === name.toLowerCase());
  const preset = getPresetFromConfig(name, {
    ...config,
    lastPrintedNumber: sequenceValue
  });

  if (existingIndex >= 0) {
    presets[existingIndex] = preset;
  } else {
    presets.push(preset);
  }

  state.savedConfigs = presets;
  state.selectedPresetName = name;
  state.lastPrintedNumber = sequenceValue;
  populateSavedConfigs(name);

  await savePresetList(presets, name);
  configNameInput.value = name;
}

async function loadSavedConfigs() {
  let fallbackPresets = readLocalPresets();

  if (!firebaseDb) {
    if (fallbackPresets.length === 0) {
      const defaultPreset = getPresetFromConfig('Mặc định', getCurrentConfig());
      state.savedConfigs = [defaultPreset];
      state.selectedPresetName = defaultPreset.name;
      writeLocalPresets(state.savedConfigs, defaultPreset.name);
    } else {
      state.savedConfigs = fallbackPresets;
      state.selectedPresetName = fallbackPresets[0]?.name || 'Mặc định';
    }
    populateSavedConfigs(state.selectedPresetName);
    const selectedPreset = state.savedConfigs.find((preset) => preset.name === state.selectedPresetName) || state.savedConfigs[0];
    if (selectedPreset) {
      applyConfig(selectedPreset);
      configNameInput.value = selectedPreset.name;
      configSequenceInput.value = Number(selectedPreset.lastPrintedNumber || 0);
      state.lastPrintedNumber = Number(selectedPreset.lastPrintedNumber || 0);
    }
    return;
  }

  try {
    const ref = doc(firebaseDb, 'settings', PRESET_DOC);
    const snapshot = await getDoc(ref);

    if (snapshot.exists()) {
      const data = snapshot.data() || {};
      const presets = Array.isArray(data.presets) ? data.presets : fallbackPresets;
      const activePresetName = data.selectedPreset || presets[0]?.name || 'Mặc định';

      if (presets.length > 0) {
        state.savedConfigs = presets.map((preset) => getPresetFromConfig(preset.name || 'Mặc định', preset));
        state.selectedPresetName = state.savedConfigs.some((preset) => preset.name === activePresetName)
          ? activePresetName
          : state.savedConfigs[0].name;
        writeLocalPresets(state.savedConfigs, state.selectedPresetName);
        populateSavedConfigs(state.selectedPresetName);

        const selectedPreset = state.savedConfigs.find((preset) => preset.name === state.selectedPresetName);
        if (selectedPreset) {
          applyConfig(selectedPreset);
          configNameInput.value = selectedPreset.name;
        }
        return;
      }
    }

    if (fallbackPresets.length > 0) {
      state.savedConfigs = fallbackPresets;
      state.selectedPresetName = fallbackPresets[0]?.name || 'Mặc định';
      populateSavedConfigs(state.selectedPresetName);
      const selectedPreset = state.savedConfigs.find((preset) => preset.name === state.selectedPresetName) || state.savedConfigs[0];
      if (selectedPreset) {
        applyConfig(selectedPreset);
        configNameInput.value = selectedPreset.name;
        configSequenceInput.value = Number(selectedPreset.lastPrintedNumber || 0);
        state.lastPrintedNumber = Number(selectedPreset.lastPrintedNumber || 0);
      }
      return;
    }

    const defaultPreset = getPresetFromConfig('Mặc định', getCurrentConfig());
    state.savedConfigs = [defaultPreset];
    state.selectedPresetName = defaultPreset.name;
    populateSavedConfigs(defaultPreset.name);
    await savePresetList(state.savedConfigs, defaultPreset.name);
  } catch (error) {
    console.error('Failed to load saved configs:', error);
    if (fallbackPresets.length > 0) {
      state.savedConfigs = fallbackPresets;
      state.selectedPresetName = fallbackPresets[0]?.name || 'Mặc định';
      populateSavedConfigs(state.selectedPresetName);
      const selectedPreset = state.savedConfigs.find((preset) => preset.name === state.selectedPresetName) || state.savedConfigs[0];
      if (selectedPreset) {
        applyConfig(selectedPreset);
        configNameInput.value = selectedPreset.name;
        configSequenceInput.value = Number(selectedPreset.lastPrintedNumber || 0);
        state.lastPrintedNumber = Number(selectedPreset.lastPrintedNumber || 0);
      }
    }
  }
}

async function saveLabelSettings() {
  const settings = {
    text: textInput.value || '',
    fontFamily: fontSelect.value || 'Calibri',
    fontSize: clamp(Number(fontSizeInput.value) || 12, 6, MAX_FONT_SIZE),
    color: colorInput.value || '#111827',
    bold: Boolean(state.bold),
    italic: Boolean(state.italic),
    underline: Boolean(state.underline),
    align: state.align || 'center',
    updatedAt: Date.now()
  };

  try {
    localStorage.setItem('labelWhiteSettingsLocal', JSON.stringify(settings));
  } catch (error) {
    console.warn('Unable to save local label settings:', error);
  }

  if (!firebaseDb) return;

  try {
    await setDoc(doc(firebaseDb, 'settings', SETTINGS_DOC), settings, { merge: true });
  } catch (error) {
    console.error('Failed to save label settings:', error);
  }
}

async function loadLabelSettings() {
  try {
    const rawLocal = localStorage.getItem('labelWhiteSettingsLocal');
    if (rawLocal) {
      const localSettings = JSON.parse(rawLocal);
      if (localSettings && localSettings.text !== undefined) {
        applyConfig(localSettings);
      }
    }
  } catch (error) {
    console.warn('Unable to load local label settings:', error);
  }

  if (!firebaseDb) return;

  try {
    const ref = doc(firebaseDb, 'settings', SETTINGS_DOC);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) return;

    const data = snapshot.data();
    if (!data) return;

    const config = {
      text: data.text || 'A',
      fontFamily: data.fontFamily || 'Calibri',
      fontSize: clamp(Number(data.fontSize) || 12, 6, MAX_FONT_SIZE),
      color: data.color || '#111827',
      bold: Boolean(data.bold),
      italic: Boolean(data.italic),
      underline: Boolean(data.underline),
      align: data.align || 'center'
    };

    applyConfig(config);
    localStorage.setItem('labelWhiteSettingsLocal', JSON.stringify(config));
  } catch (error) {
    console.error('Failed to load label settings:', error);
  }
}

async function saveLastPrintCount(value) {
  const safeValue = clamp(Number(value) || 1, 1, 500);
  try {
    localStorage.setItem(LOCAL_LAST_PRINT_KEY, String(safeValue));
  } catch (error) {
    console.warn('Unable to save local last print count:', error);
  }

  if (!firebaseDb) return;
  try {
    await setDoc(doc(firebaseDb, 'settings', 'labelWhiteLastPrint'), {
      lastPrintCount: safeValue,
      updatedAt: Date.now()
    }, { merge: true });
  } catch (error) {
    console.error('Failed to save last print count:', error);
  }
}

async function loadLastPrintCount() {
  try {
    const localValue = Number(localStorage.getItem(LOCAL_LAST_PRINT_KEY) || '1');
    if (!Number.isNaN(localValue) && localValue > 0) {
      pdfQuantityInput.value = clamp(localValue, 1, 500);
    }
  } catch (error) {
    console.warn('Unable to load local last print count:', error);
  }

  if (!firebaseDb) return;

  try {
    const ref = doc(firebaseDb, 'settings', 'labelWhiteLastPrint');
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) return;

    const value = Number(snapshot.data()?.lastPrintCount || 1);
    pdfQuantityInput.value = clamp(value, 1, 500);
    localStorage.setItem(LOCAL_LAST_PRINT_KEY, String(pdfQuantityInput.value));
  } catch (error) {
    console.error('Failed to load last print count:', error);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function applyConfig(config) {
  state.text = config.text || '';
  state.fontFamily = config.fontFamily || 'Calibri';
  state.fontSize = clamp(Number(config.fontSize) || 12, 6, MAX_FONT_SIZE);
  state.color = config.color || '#111827';
  state.bold = Boolean(config.bold);
  state.italic = Boolean(config.italic);
  state.underline = Boolean(config.underline);
  state.align = config.align || 'center';

  textInput.value = state.text;
  fontSelect.value = state.fontFamily;
  fontSizeInput.value = state.fontSize;
  colorInput.value = state.color;
  setToggleButton(boldBtn, state.bold);
  setToggleButton(italicBtn, state.italic);
  setToggleButton(underlineBtn, state.underline);
  updateColorLabel();
  updatePreview();
}

function syncStateFromInputs() {
  state.text = textInput.value || '';
  state.fontFamily = fontSelect.value;
  state.fontSize = clamp(Number(fontSizeInput.value) || 12, 6, MAX_FONT_SIZE);
  state.color = colorInput.value;
  state.bold = boldBtn.classList.contains('ring-2');
  state.italic = italicBtn.classList.contains('ring-2');
  state.underline = underlineBtn.classList.contains('ring-2');
  state.align = 'center';
  updatePreview();
}

function setToggleButton(button, active) {
  const classes = ['ring-2', 'ring-slate-400', 'ring-offset-2', 'ring-offset-white'];
  if (active) {
    button.classList.add(...classes);
    button.classList.add('bg-slate-800', 'text-white');
    button.classList.remove('bg-white', 'text-slate-800');
  } else {
    button.classList.remove(...classes);
    button.classList.add('bg-white', 'text-slate-800');
    button.classList.remove('bg-slate-800', 'text-white');
  }
}

function applyFormattingStyle() {
  const weight = state.bold ? '700' : '400';
  const italic = state.italic ? 'italic' : 'normal';
  const underline = state.underline ? 'underline' : 'none';
  const fontSize = getAutoFitFontSize(state.text, state.fontFamily, state.fontSize, state.bold, state.italic);

  labelContent.style.fontFamily = state.fontFamily;
  labelContent.style.fontSize = `${fontSize}px`;
  labelContent.style.fontWeight = weight;
  labelContent.style.fontStyle = italic;
  labelContent.style.textDecoration = underline;
  labelContent.style.color = state.color;
  labelContent.style.justifyContent = 'center';
  labelContent.style.alignItems = 'center';
  labelContent.style.width = '100%';
  labelContent.style.height = '100%';
  labelContent.style.display = 'flex';
  labelContent.style.textAlign = 'center';
  labelContent.style.padding = '4mm';
  labelContent.style.transform = 'translateZ(0)';
  labelContent.style.letterSpacing = '0';
  labelContent.style.lineHeight = '1.1';
}

function updatePreview() {
  const text = state.text;
  labelContent.textContent = text || ' ';
  applyFormattingStyle();
  labelContent.textContent = text || ' ';
}

function updateColorLabel() {
  colorTextLabel.textContent = colorInput.value.toUpperCase();
}

function setTextAndSync() {
  state.text = textInput.value || '';
  updatePreview();
}

function advancePrintedSequence(increment = 1) {
  const nextValue = clamp(Number(configSequenceInput.value || 0) + increment, 0, 999999);
  configSequenceInput.value = nextValue;
  state.lastPrintedNumber = nextValue;

  const selectedName = state.selectedPresetName || configNameInput.value || 'Mặc định';
  if (!selectedName) return;

  const targetPreset = state.savedConfigs.find((preset) => preset.name === selectedName);
  if (!targetPreset) return;

  targetPreset.lastPrintedNumber = nextValue;
  const presetIndex = state.savedConfigs.findIndex((preset) => preset.name === selectedName);
  if (presetIndex >= 0) {
    state.savedConfigs[presetIndex] = { ...targetPreset };
  }

  savePresetList(state.savedConfigs, selectedName);
}

function printCurrentLabel() {
  syncStateFromInputs();
  saveLabelSettings();

  const copyCount = getPrintQuantity(pdfQuantityInput.value);
  pdfQuantityInput.value = copyCount;
  saveLastPrintCount(copyCount);

  const preview = document.querySelector('.printable-label');
  const content = document.getElementById('labelContent');

  if (content) {
    content.textContent = textInput.value || ' ';
    applyFormattingStyle();
  }

  if (preview) {
    preview.style.visibility = 'visible';
    preview.style.display = 'flex';
  }

  advancePrintedSequence(copyCount);
  window.print();
}

function generatePdf(count = 1) {
  syncStateFromInputs();
  const safeCount = getPrintQuantity(count);
  pdfQuantityInput.value = safeCount;
  saveLastPrintCount(safeCount);

  const config = getCurrentConfig();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({
    unit: 'mm',
    format: [90, 60],
    orientation: 'landscape'
  });

  const canvas = document.createElement('canvas');
  canvas.width = LABEL_WIDTH_PX;
  canvas.height = LABEL_HEIGHT_PX;
  const ctx = canvas.getContext('2d');

  const text = (config.text || ' ').trim() || ' ';
  const fontFamily = config.fontFamily;
  const textColor = config.color;
  const fitFontSize = getAutoFitFontSize(text, fontFamily, config.fontSize, config.bold, config.italic);

  for (let index = 0; index < safeCount; index += 1) {
    if (index > 0) {
      doc.addPage([90, 60], 'landscape');
    }

    ctx.clearRect(0, 0, LABEL_WIDTH_PX, LABEL_HEIGHT_PX);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, LABEL_WIDTH_PX, LABEL_HEIGHT_PX);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor;
    ctx.font = buildCanvasFont(fontFamily, fitFontSize, config.bold, config.italic);

    const lines = String(text || ' ').replace(/\r/g, '').split('\n');
    const lineHeight = fitFontSize * 1.12;
    const startY = LABEL_HEIGHT_PX / 2 - ((lines.length - 1) * lineHeight) / 2;

    lines.forEach((line, lineIndex) => {
      ctx.fillText(line || ' ', LABEL_WIDTH_PX / 2, startY + lineIndex * lineHeight);
    });

    const imageData = canvas.toDataURL('image/png');
    doc.addImage(imageData, 'PNG', 0, 0, 90, 60, undefined, 'FAST');
  }

  const nextSequence = clamp(Number(configSequenceInput.value || 0) + safeCount, 0, 999999);
  configSequenceInput.value = nextSequence;
  state.lastPrintedNumber = nextSequence;

  const selectedName = state.selectedPresetName || configNameInput.value || 'Mặc định';
  if (selectedName) {
    const targetPreset = state.savedConfigs.find((preset) => preset.name === selectedName);
    if (targetPreset) {
      targetPreset.lastPrintedNumber = nextSequence;
      const presetIndex = state.savedConfigs.findIndex((preset) => preset.name === selectedName);
      if (presetIndex >= 0) {
        state.savedConfigs[presetIndex] = { ...targetPreset };
      }
      savePresetList(state.savedConfigs, selectedName);
    }
  }

  doc.save('tem-nhan-trang.pdf');
}

function initializeControls() {
  applyConfig({
    text: state.text || 'A',
    fontFamily: state.fontFamily || 'Calibri',
    fontSize: state.fontSize || 12,
    color: state.color || '#111827',
    bold: Boolean(state.bold),
    italic: Boolean(state.italic),
    underline: Boolean(state.underline),
    align: state.align || 'center'
  });
}

window.printCurrentLabel = printCurrentLabel;
window.generatePdf = generatePdf;

textInput.addEventListener('input', () => {
  setTextAndSync();
  saveLabelSettings();
});

fontSelect.addEventListener('change', () => {
  state.fontFamily = fontSelect.value;
  updatePreview();
  saveLabelSettings();
});

fontSizeInput.addEventListener('input', () => {
  const val = clamp(Number(fontSizeInput.value) || 12, 6, MAX_FONT_SIZE);
  fontSizeInput.value = val;
  state.fontSize = val;
  updatePreview();
  saveLabelSettings();
});

colorInput.addEventListener('input', () => {
  state.color = colorInput.value;
  updateColorLabel();
  updatePreview();
  saveLabelSettings();
});

boldBtn.addEventListener('click', () => {
  state.bold = !state.bold;
  setToggleButton(boldBtn, state.bold);
  updatePreview();
  saveLabelSettings();
});

italicBtn.addEventListener('click', () => {
  state.italic = !state.italic;
  setToggleButton(italicBtn, state.italic);
  updatePreview();
  saveLabelSettings();
});

underlineBtn.addEventListener('click', () => {
  state.underline = !state.underline;
  setToggleButton(underlineBtn, state.underline);
  updatePreview();
  saveLabelSettings();
});

document.querySelectorAll('[data-size-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const delta = button.dataset.sizeAction === 'increase' ? 1 : -1;
    const value = clamp((Number(fontSizeInput.value) || 12) + delta, 6, MAX_FONT_SIZE);
    fontSizeInput.value = value;
    state.fontSize = value;
    updatePreview();
    saveLabelSettings();
  });
});

alignBtn.addEventListener('click', () => {
  state.align = 'center';
  updatePreview();
  saveLabelSettings();
});

saveConfigBtn.addEventListener('click', async () => {
  await saveCurrentPreset();
});

savedConfigSelect.addEventListener('change', async () => {
  const selectedName = savedConfigSelect.value;
  if (!selectedName) {
    return;
  }

  const selectedPreset = state.savedConfigs.find((preset) => preset.name === selectedName);
  if (!selectedPreset) {
    return;
  }

  state.selectedPresetName = selectedName;
  configNameInput.value = selectedName;
  configSequenceInput.value = Number(selectedPreset.lastPrintedNumber || 0);
  state.lastPrintedNumber = Number(selectedPreset.lastPrintedNumber || 0);
  applyConfig(selectedPreset);
  await savePresetList(state.savedConfigs, selectedName);
});

configSequenceInput.addEventListener('input', () => {
  const nextValue = clamp(Number(configSequenceInput.value) || 0, 0, 999999);
  configSequenceInput.value = nextValue;
  state.lastPrintedNumber = nextValue;
});

pdfQuantityInput.addEventListener('input', () => {
  const nextValue = getPrintQuantity(pdfQuantityInput.value);
  pdfQuantityInput.value = nextValue;
  saveLastPrintCount(nextValue);
});

printBtn.addEventListener('click', printCurrentLabel);
downloadPdfBtn.addEventListener('click', () => generatePdf(pdfQuantityInput.value));

initializeControls();
loadLabelSettings();
loadSavedConfigs();
loadLastPrintCount();
