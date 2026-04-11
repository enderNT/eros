const state = {
  workspaceRoot: "",
  files: [],
  isModalOpen: false,
  mode: null,
  currentPath: "",
  records: [],
  selectedRecordId: null,
  dirty: false,
  searchTerm: "",
  localSourceName: "",
  lastLoadedAt: null
};

const elements = {
  addEntryBtn: document.querySelector("#add-entry-btn"),
  deleteEntryBtn: document.querySelector("#delete-entry-btn"),
  downloadBtn: document.querySelector("#download-btn"),
  duplicateEntryBtn: document.querySelector("#duplicate-entry-btn"),
  dirtyLabel: document.querySelector("#dirty-label"),
  editorSubtitle: document.querySelector("#editor-subtitle"),
  editorTextarea: document.querySelector("#editor-textarea"),
  editorTitle: document.querySelector("#editor-title"),
  editorModalBackdrop: document.querySelector("#editor-modal-backdrop"),
  entryList: document.querySelector("#entry-list"),
  errorCount: document.querySelector("#error-count"),
  fileOptions: document.querySelector("#file-options"),
  fileStateLabel: document.querySelector("#file-state-label"),
  filteredCount: document.querySelector("#filtered-count"),
  formatBtn: document.querySelector("#format-btn"),
  jumpBtn: document.querySelector("#jump-btn"),
  jumpInput: document.querySelector("#jump-input"),
  loadWorkspaceBtn: document.querySelector("#load-workspace-btn"),
  localFileInput: document.querySelector("#local-file-input"),
  modeLabel: document.querySelector("#mode-label"),
  modalDirtyLabel: document.querySelector("#modal-dirty-label"),
  modalEditorTextarea: document.querySelector("#modal-editor-textarea"),
  modalFormatBtn: document.querySelector("#modal-format-btn"),
  modalValidationLabel: document.querySelector("#modal-validation-label"),
  pathInput: document.querySelector("#path-input"),
  closeModalBtn: document.querySelector("#close-modal-btn"),
  openModalBtn: document.querySelector("#open-modal-btn"),
  recordCount: document.querySelector("#record-count"),
  refreshFilesBtn: document.querySelector("#refresh-files-btn"),
  saveBtn: document.querySelector("#save-btn"),
  searchInput: document.querySelector("#search-input"),
  statusBanner: document.querySelector("#status-banner"),
  validationLabel: document.querySelector("#validation-label"),
  workspaceRootLabel: document.querySelector("#workspace-root-label")
};

function createRecord(rawLine) {
  const trimmed = rawLine.trim();
  const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

  if (!trimmed) {
    return {
      id,
      raw: rawLine,
      editorValue: rawLine,
      preview: "<linea vacia>",
      valid: false,
      error: "La linea esta vacia."
    };
  }

  try {
    const parsed = JSON.parse(rawLine);
    const normalizedRaw = JSON.stringify(parsed);
    const previewSource =
      typeof parsed === "object" && parsed !== null
        ? normalizedRaw.slice(0, 180)
        : String(parsed);

    return {
      id,
      raw: normalizedRaw,
      editorValue: JSON.stringify(parsed, null, 2),
      preview: previewSource,
      valid: true,
      error: ""
    };
  } catch (error) {
    return {
      id,
      raw: rawLine,
      editorValue: rawLine,
      preview: rawLine.slice(0, 180) || "<linea vacia>",
      valid: false,
      error: error instanceof Error ? error.message : "JSON invalido"
    };
  }
}

function splitJsonRecords(text) {
  if (!text.trim()) {
    return [];
  }

  const records = [];
  let buffer = "";
  let depth = 0;
  let inString = false;
  let escaping = false;
  let started = false;

  for (const char of text) {
    if (!started) {
      if (/\s/.test(char)) {
        continue;
      }

      started = true;
      buffer = "";
      depth = 0;
      inString = false;
      escaping = false;
    }

    buffer += char;

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth = Math.max(depth - 1, 0);

      if (depth === 0) {
        records.push(buffer.trim());
        buffer = "";
        started = false;
      }
    }
  }

  if (buffer.trim()) {
    records.push(buffer.trim());
  }

  return records;
}

function parseJsonl(text) {
  return splitJsonRecords(text).map((recordText) => createRecord(recordText));
}

function serializeJsonl(records) {
  if (!records.length) {
    return "";
  }

  return `${records.map((record) => record.raw).join("\n")}\n`;
}

function setBanner(message, tone = "neutral") {
  elements.statusBanner.textContent = message;
  elements.statusBanner.className = `status-banner ${tone}`;
}

function setDirty(nextDirty) {
  state.dirty = nextDirty;
  elements.dirtyLabel.textContent = nextDirty ? "Cambios sin guardar" : "Sin cambios";
  elements.dirtyLabel.className = `pill ${nextDirty ? "danger" : "neutral"}`;
  elements.modalDirtyLabel.textContent = elements.dirtyLabel.textContent;
  elements.modalDirtyLabel.className = elements.dirtyLabel.className;
}

function getSelectedRecordIndex() {
  return state.records.findIndex((record) => record.id === state.selectedRecordId);
}

function getSelectedRecord() {
  return state.records.find((record) => record.id === state.selectedRecordId) || null;
}

function getFilteredRecords() {
  const term = state.searchTerm.trim().toLowerCase();

  if (!term) {
    return state.records;
  }

  return state.records.filter((record) => record.raw.toLowerCase().includes(term));
}

function updateSummaryCards() {
  const filteredRecords = getFilteredRecords();
  const invalidCount = state.records.filter((record) => !record.valid).length;

  elements.recordCount.textContent = String(state.records.length);
  elements.filteredCount.textContent = String(filteredRecords.length);
  elements.errorCount.textContent = String(invalidCount);
  elements.modeLabel.textContent = state.mode === "workspace" ? "Workspace" : state.mode === "local" ? "Local" : "Ninguno";

  const sourceLabel =
    state.mode === "workspace"
      ? `Workspace: ${state.currentPath || "sin archivo"}`
      : state.mode === "local"
        ? `Local: ${state.localSourceName || "sin archivo"}`
        : "Sin archivo abierto";

  elements.fileStateLabel.textContent = sourceLabel;
}

function renderEntryList() {
  const filteredRecords = getFilteredRecords();
  elements.entryList.innerHTML = "";

  if (!filteredRecords.length) {
    const empty = document.createElement("div");
    empty.className = "entry-item";
    empty.textContent = state.records.length ? "No hay coincidencias para la busqueda actual." : "No hay registros cargados.";
    elements.entryList.appendChild(empty);
    return;
  }

  filteredRecords.forEach((record) => {
    const index = state.records.findIndex((item) => item.id === record.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `entry-item${record.id === state.selectedRecordId ? " active" : ""}${record.valid ? "" : " invalid"}`;
    button.dataset.recordId = record.id;
    button.innerHTML = `
      <div class="entry-meta">
        <strong>Registro ${index + 1}</strong>
        <span>${record.valid ? "OK" : "Error"}</span>
      </div>
      <div class="entry-preview">${escapeHtml(record.preview)}</div>
    `;
    button.addEventListener("click", () => selectRecord(record.id));
    elements.entryList.appendChild(button);
  });
}

function updateEditor(preserveSource = null) {
  const record = getSelectedRecord();

  if (!record) {
    elements.editorTitle.textContent = "Editor";
    elements.editorSubtitle.textContent = "Selecciona una linea para editarla.";
    elements.editorTextarea.value = "";
    elements.editorTextarea.disabled = true;
    elements.validationLabel.textContent = "Sin seleccion";
    elements.validationLabel.className = "pill neutral";
    elements.modalEditorTextarea.value = "";
    elements.modalEditorTextarea.disabled = true;
    elements.modalValidationLabel.textContent = "Sin seleccion";
    elements.modalValidationLabel.className = "pill neutral";
    return;
  }

  const index = getSelectedRecordIndex();
  elements.editorTitle.textContent = `Registro ${index + 1}`;
  elements.editorSubtitle.textContent = record.valid
    ? "El contenido es JSON valido y esta listo para guardar."
    : `Corrige el JSON antes de guardar. Error: ${record.error}`;
  elements.editorTextarea.disabled = false;

  const editorValue = record.editorValue || record.raw;
  if (preserveSource !== "main" && elements.editorTextarea.value !== editorValue) {
    elements.editorTextarea.value = editorValue;
  }
  if (preserveSource !== "modal" && elements.modalEditorTextarea.value !== editorValue) {
    elements.modalEditorTextarea.value = editorValue;
  }
  elements.modalEditorTextarea.disabled = false;

  elements.validationLabel.textContent = record.valid ? "JSON valido" : "JSON invalido";
  elements.validationLabel.className = `pill ${record.valid ? "success" : "danger"}`;
  elements.modalValidationLabel.textContent = elements.validationLabel.textContent;
  elements.modalValidationLabel.className = elements.validationLabel.className;
}

function render() {
  updateSummaryCards();
  renderEntryList();
  updateEditor();
}

function selectRecord(recordId) {
  state.selectedRecordId = recordId;
  render();
}

function openEditorModal() {
  if (!getSelectedRecord()) {
    setBanner("Selecciona un registro antes de abrir el modal.", "danger");
    return;
  }

  state.isModalOpen = true;
  elements.editorModalBackdrop.hidden = false;
  document.body.classList.add("modal-open");
  updateEditor();
  elements.modalEditorTextarea.focus();
}

function closeEditorModal() {
  state.isModalOpen = false;
  elements.editorModalBackdrop.hidden = true;
  document.body.classList.remove("modal-open");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loadRecords({ content, mode, path = "", localSourceName = "" }) {
  state.mode = mode;
  state.currentPath = path;
  state.localSourceName = localSourceName;
  state.searchTerm = "";
  elements.searchInput.value = "";
  state.records = parseJsonl(content);
  state.selectedRecordId = state.records[0]?.id || null;
  state.lastLoadedAt = new Date().toISOString();
  setDirty(false);
  render();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

async function refreshFileList({ silent = false } = {}) {
  try {
    const payload = await fetchJson("/api/files");
    state.workspaceRoot = payload.workspaceRoot;
    state.files = payload.files;
    elements.workspaceRootLabel.textContent = `Workspace: ${payload.workspaceRoot}`;
    elements.fileOptions.innerHTML = "";

    payload.files.forEach((filePath) => {
      const option = document.createElement("option");
      option.value = filePath;
      elements.fileOptions.appendChild(option);
    });

    if (!elements.pathInput.value && payload.files.length) {
      elements.pathInput.value = payload.files[0];
    }

    if (!silent) {
      setBanner(`Lista actualizada. ${payload.files.length} archivos JSONL detectados.`, "success");
    }
  } catch (error) {
    setBanner(error instanceof Error ? error.message : "No se pudo cargar la lista de archivos.", "danger");
  }
}

async function openWorkspaceFile() {
  const requestedPath = elements.pathInput.value.trim();

  if (!requestedPath) {
    setBanner("Escribe una ruta relativa del workspace para abrir un archivo.", "danger");
    return;
  }

  try {
    const payload = await fetchJson("/api/load", {
      method: "POST",
      body: JSON.stringify({ path: requestedPath })
    });

    loadRecords({
      content: payload.content,
      mode: "workspace",
      path: payload.path
    });

    setBanner(`Archivo cargado: ${payload.path} (${state.records.length} registros).`, "success");
  } catch (error) {
    setBanner(error instanceof Error ? error.message : "No se pudo abrir el archivo.", "danger");
  }
}

async function saveWorkspaceFile() {
  if (state.mode !== "workspace" || !state.currentPath) {
    setBanner("Abre un archivo del workspace antes de guardar.", "danger");
    return;
  }

  if (state.records.some((record) => !record.valid)) {
    setBanner("Hay lineas con JSON invalido. Corrigelas antes de guardar.", "danger");
    return;
  }

  try {
    const payload = await fetchJson("/api/save", {
      method: "POST",
      body: JSON.stringify({
        path: state.currentPath,
        content: serializeJsonl(state.records)
      })
    });

    setDirty(false);
    setBanner(`Archivo guardado (${payload.lineCount} lineas): ${payload.path}`, "success");
    await refreshFileList({ silent: true });
  } catch (error) {
    setBanner(error instanceof Error ? error.message : "No se pudo guardar el archivo.", "danger");
  }
}

function updateRecordFromTextArea(event) {
  const record = getSelectedRecord();
  if (!record) {
    return;
  }

  const source = event?.target === elements.modalEditorTextarea ? "modal" : "main";
  const userText = source === "modal" ? elements.modalEditorTextarea.value : elements.editorTextarea.value;

  if (!userText.trim()) {
    record.raw = "";
    record.editorValue = userText;
    record.preview = "<linea vacia>";
    record.valid = false;
    record.error = "La linea esta vacia.";
    setDirty(true);
    renderEntryList();
    updateEditor(source);
    return;
  }

  try {
    const normalized = JSON.stringify(JSON.parse(userText));
    const nextRecord = createRecord(normalized);
    Object.assign(record, nextRecord, {
      id: record.id,
      editorValue: userText
    });
  } catch (error) {
    record.raw = userText;
    record.editorValue = userText;
    record.preview = userText.slice(0, 180);
    record.valid = false;
    record.error = error instanceof Error ? error.message : "JSON invalido";
  }

  setDirty(true);
  renderEntryList();
  updateEditor(source);
  updateSummaryCards();
}

function addRecord() {
  const emptyRecord = createRecord('{"new_record": true}');
  state.records.push(emptyRecord);
  state.selectedRecordId = emptyRecord.id;
  setDirty(true);
  render();
  setBanner("Se agrego un nuevo registro al final.", "success");
}

function duplicateRecord() {
  const record = getSelectedRecord();
  if (!record) {
    setBanner("Selecciona un registro para duplicarlo.", "danger");
    return;
  }

  const index = getSelectedRecordIndex();
  const duplicated = createRecord(record.raw);
  state.records.splice(index + 1, 0, duplicated);
  state.selectedRecordId = duplicated.id;
  setDirty(true);
  render();
  setBanner("Registro duplicado.", "success");
}

function deleteRecord() {
  const index = getSelectedRecordIndex();
  if (index === -1) {
    setBanner("Selecciona un registro para eliminarlo.", "danger");
    return;
  }

  state.records.splice(index, 1);
  state.selectedRecordId = state.records[index]?.id || state.records[index - 1]?.id || null;
  setDirty(true);
  render();
  setBanner("Registro eliminado.", "success");
}

function formatSelectedRecord(source = "main") {
  const record = getSelectedRecord();
  if (!record) {
    setBanner("Selecciona una linea para formatearla.", "danger");
    return;
  }

  try {
    const currentValue = source === "modal" ? elements.modalEditorTextarea.value : elements.editorTextarea.value;
    const formatted = JSON.stringify(JSON.parse(currentValue || record.editorValue || record.raw), null, 2);
    record.editorValue = formatted;
    if (source === "modal") {
      elements.modalEditorTextarea.value = formatted;
    } else {
      elements.editorTextarea.value = formatted;
    }
    updateEditor(source);
    setBanner("JSON formateado en el editor.", "success");
  } catch (error) {
    setBanner("No se puede formatear mientras el JSON sea invalido.", "danger");
  }
}

function jumpToRecord() {
  const requestedIndex = Number(elements.jumpInput.value);

  if (!Number.isInteger(requestedIndex) || requestedIndex < 1 || requestedIndex > state.records.length) {
    setBanner("Escribe un numero de linea valido.", "danger");
    return;
  }

  const record = state.records[requestedIndex - 1];
  if (record) {
    state.selectedRecordId = record.id;
    render();
  }
}

function downloadCurrentJsonl() {
  if (!state.records.length) {
    setBanner("No hay datos para descargar.", "danger");
    return;
  }

  const blob = new Blob([serializeJsonl(state.records)], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const fallbackName = state.currentPath.split("/").pop() || state.localSourceName || "dataset.jsonl";

  anchor.href = url;
  anchor.download = fallbackName;
  anchor.click();
  URL.revokeObjectURL(url);
  setBanner("Descarga iniciada.", "success");
}

function handleLocalFileSelection(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    loadRecords({
      content: typeof reader.result === "string" ? reader.result : "",
      mode: "local",
      localSourceName: file.name
    });
    elements.localFileInput.value = "";
    setBanner(`Archivo local cargado: ${file.name} (${state.records.length} registros).`, "success");
  };
  reader.onerror = () => {
    setBanner("No se pudo leer el archivo local.", "danger");
  };
  reader.readAsText(file);
}

function bindEvents() {
  elements.refreshFilesBtn.addEventListener("click", refreshFileList);
  elements.loadWorkspaceBtn.addEventListener("click", openWorkspaceFile);
  elements.saveBtn.addEventListener("click", saveWorkspaceFile);
  elements.addEntryBtn.addEventListener("click", addRecord);
  elements.duplicateEntryBtn.addEventListener("click", duplicateRecord);
  elements.deleteEntryBtn.addEventListener("click", deleteRecord);
  elements.formatBtn.addEventListener("click", () => formatSelectedRecord("main"));
  elements.downloadBtn.addEventListener("click", downloadCurrentJsonl);
  elements.openModalBtn.addEventListener("click", openEditorModal);
  elements.closeModalBtn.addEventListener("click", closeEditorModal);
  elements.modalFormatBtn.addEventListener("click", () => formatSelectedRecord("modal"));
  elements.jumpBtn.addEventListener("click", jumpToRecord);
  elements.searchInput.addEventListener("input", (event) => {
    state.searchTerm = event.target.value;
    render();
  });
  elements.editorTextarea.addEventListener("input", updateRecordFromTextArea);
  elements.modalEditorTextarea.addEventListener("input", updateRecordFromTextArea);
  elements.editorModalBackdrop.addEventListener("click", (event) => {
    if (event.target === elements.editorModalBackdrop) {
      closeEditorModal();
    }
  });
  elements.localFileInput.addEventListener("change", handleLocalFileSelection);
  elements.pathInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      openWorkspaceFile();
    }
  });
  elements.jumpInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      jumpToRecord();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.isModalOpen) {
      closeEditorModal();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (state.mode === "workspace") {
        saveWorkspaceFile();
      } else {
        downloadCurrentJsonl();
      }
    }
  });
}

async function init() {
  bindEvents();
  render();
  await refreshFileList();
}

init();
