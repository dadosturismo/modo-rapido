const GAS_URL = "https://script.google.com/macros/s/AKfycbxWamWQao1eQXOYOrH0mDIl2QyEmQqE75UVit36eptNhIF0Ju87qwNNfgk9DGdWJAP5/exec";
const DB_NAME = "turismo-atendimentos-v3";
const QUEUE_STORE = "pendentes";
const OPTIONS_STORE = "opcoes";
const PREFERENCES_STORE = "preferencias";
const $ = (id) => document.getElementById(id);

let options;
let syncing = false;
let savedAttraction = "";
let retryTimer;
let editingIdentification = false;
let selectedInformationItems = [];
const RENAMED_ATTRACTIONS = { "Torre Panorâmica": "Torre Panorâmica (Recepção)" };
const COUNTRIES_ADDED_LOCALLY = ["Escócia", "Inglaterra", "País de Gales", "Irlanda do Norte"];
const ALLOWED_ATTRACTIONS = ["Torre Panorâmica (Elevador)", "Torre Panorâmica (Recepção)"];

const db = new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 3);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(QUEUE_STORE)) database.createObjectStore(QUEUE_STORE, { keyPath: "idEnvio" });
    if (!database.objectStoreNames.contains(OPTIONS_STORE)) database.createObjectStore(OPTIONS_STORE);
    if (!database.objectStoreNames.contains(PREFERENCES_STORE)) database.createObjectStore(PREFERENCES_STORE);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function readValue(storeName, key) {
  const database = await db;
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeValue(storeName, value, key) {
  const database = await db;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

async function pendingRecords() {
  const database = await db;
  return new Promise((resolve, reject) => {
    const request = database.transaction(QUEUE_STORE, "readonly").objectStore(QUEUE_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function removePending(id) {
  const database = await db;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(QUEUE_STORE, "readwrite");
    transaction.objectStore(QUEUE_STORE).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function selected(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || "";
}

function normalize(text) {
  return String(text || "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function availableCountries() {
  return Array.from(new Set([...(options?.paises || []), ...COUNTRIES_ADDED_LOCALLY]));
}

function canonicalCountry(value) {
  const typed = normalize(value);
  return availableCountries().find((country) => normalize(country) === typed) || "";
}

function setMessage(text = "", isError = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", isError);
}

function currentAttraction() {
  return options?.atrativos?.[$("attraction").value];
}

function requiresInformation(config) {
  return config?.solicitaInformacao !== false;
}

function populateSelect(element, values, placeholder) {
  element.replaceChildren(new Option(placeholder, ""));
  values.forEach((value) => element.add(new Option(value, value)));
}

function populateInformation(config) {
  const select = $("information");
  select.replaceChildren(new Option("Selecione a informação", ""));
  [["Principais", config.principais], ["Outros", config.outros]].forEach(([label, values]) => {
    const group = document.createElement("optgroup");
    group.label = label;
    values.forEach((value) => group.append(new Option(value, value)));
    select.append(group);
  });
}

function matchingCountries(filter = "") {
  const text = normalize(filter);
  return availableCountries().filter((country) => normalize(country).includes(text));
}

function hideCountrySuggestions() {
  show($("countrySuggestions"), false);
  $("country").setAttribute("aria-expanded", "false");
}

function setCountry(country) {
  $("country").value = canonicalCountry(country) || country;
  hideCountrySuggestions();
  updateSaveButton();
}

function commitTypedCountry() {
  const country = canonicalCountry($("country").value);
  if (country) $("country").value = country;
  hideCountrySuggestions();
  updateSaveButton();
}

function renderCountrySuggestions() {
  const input = $("country");
  const suggestions = $("countrySuggestions");
  const countries = matchingCountries(input.value);
  suggestions.replaceChildren();

  if (input.disabled || !input.value.trim() || !countries.length) return hideCountrySuggestions();
  countries.forEach((country) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "suggestion";
    option.role = "option";
    option.textContent = country;
    option.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      setCountry(country);
    });
    option.addEventListener("click", () => setCountry(country));
    suggestions.append(option);
  });
  show(suggestions, true);
  input.setAttribute("aria-expanded", "true");
}

function renderSelectedInformations() {
  const container = $("selectedInformations");
  container.replaceChildren();
  selectedInformationItems.forEach((item, index) => {
    const tag = document.createElement("span");
    tag.className = "information-tag";
    tag.append(document.createTextNode(item.informacao === "Outros" ? `Outros: ${item.informacaoOutro}` : item.informacao));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-information";
    remove.dataset.index = String(index);
    remove.setAttribute("aria-label", `Remover ${item.informacao}`);
    remove.textContent = "×";
    tag.append(remove);
    container.append(tag);
  });
}

function addSelectedInformation() {
  const information = $("information").value;
  const otherInformation = $("otherInformation").value.trim();
  if (!information) return setMessage("Selecione uma informação para adicionar.", true);
  if (information === "Outros" && !otherInformation) {
    show($("otherField"), true);
    $("otherInformation").focus();
    return setMessage("Descreva a outra informação antes de adicionar.", true);
  }
  if (selectedInformationItems.some((item) => item.informacao === information)) {
    return setMessage("Esta informação já foi adicionada.", true);
  }
  selectedInformationItems.push({ informacao: information, informacaoOutro: information === "Outros" ? otherInformation : "" });
  $("information").value = "";
  $("otherInformation").value = "";
  show($("otherField"), false);
  renderSelectedInformations();
  setMessage();
  updateSaveButton();
}

function show(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function identificationIsComplete() {
  return Boolean($("name").value.trim() && currentAttraction());
}

function renderIdentification() {
  const collapsed = identificationIsComplete() && !editingIdentification;
  show($("identificationFields"), !collapsed);
  show($("identificationSummary"), collapsed);

  if (collapsed) {
    $("summaryAttraction").textContent = $("attraction").value;
    $("summaryName").textContent = $("name").value.trim();
    $("attraction").disabled = true;
    $("name").readOnly = true;
    return;
  }

  $("attraction").disabled = !options;
  $("name").readOnly = false;
}

function lockName() {
  const name = $("name");
  if (!name.value.trim()) return;
  writeValue(PREFERENCES_STORE, name.value.trim(), "nome");
  if (currentAttraction()) editingIdentification = false;
  renderIdentification();
}

function setAutomaticCityRegionState(enabled) {
  const state = $("state");
  const existingOption = state.querySelector('option[data-automatic-city-region]');
  const value = "Curitiba e Região Metropolitana";

  if (enabled) {
    if (!existingOption) {
      const option = new Option(value, value);
      option.dataset.automaticCityRegion = "true";
      state.add(option);
    }
    state.value = value;
    return;
  }

  if (existingOption) {
    const wasSelected = state.value === value;
    existingOption.remove();
    if (wasSelected) state.value = "";
  }
}

function configureOrigin() {
  const type = selected("attendanceType");
  const cityRegion = type === "Curitiba e Região Metropolitana";
  const visitor = type === "Visitante";
  let nationality = selected("nationality");

  if (cityRegion) {
    document.querySelector('input[name="nationality"][value="Brasileiro"]').checked = true;
    nationality = "Brasileiro";
    setCountry("Brasil");
    setAutomaticCityRegionState(true);
    $("automaticOrigin").textContent = "Origem definida automaticamente: Brasil · Paraná.";
  } else {
    setAutomaticCityRegionState(false);
  }

  const brazilian = nationality === "Brasileiro";
  const foreign = nationality === "Estrangeiro";

  show($("nationalityField"), visitor);
  show($("originFields"), visitor && Boolean(nationality));
  show($("automaticOrigin"), cityRegion);

  show($("stateField"), cityRegion || brazilian);
  show($("countryField"), visitor);

  $("country").disabled = !visitor || !nationality || brazilian;
  $("state").disabled = !(cityRegion || brazilian);

  if (brazilian) {
    setCountry("Brasil");
  }
  if (!visitor && !cityRegion) {
    setCountry("");
    $("state").value = "";
  }
  if (foreign) {
    if ($("country").value === "Brasil") setCountry("");
    $("state").value = "";
  }
}

function configureAttraction() {
  const config = currentAttraction();
  if (!config) {
    $("information").disabled = true;
    $("information").required = false;
    selectedInformationItems = [];
    renderSelectedInformations();
    show($("informationField"), false);
    show($("otherField"), false);
    show($("groupField"), false);
    $("groupSize").required = false;
    renderIdentification();
    updateSaveButton();
    return;
  }

  populateInformation(config);
  const informationRequired = requiresInformation(config);
  $("information").disabled = !informationRequired;
  $("information").required = false;
  $("information").value = "";
  $("otherInformation").value = "";
  selectedInformationItems = [];
  renderSelectedInformations();
  show($("informationField"), informationRequired);
  show($("otherField"), false);
  show($("groupField"), config.permiteGrupo);
  $("groupSize").required = config.permiteGrupo;
  savedAttraction = $("attraction").value;
  writeValue(PREFERENCES_STORE, $("attraction").value, "atrativo");
  if ($("name").value.trim()) editingIdentification = false;
  renderIdentification();
  configureOrigin();
  updateSaveButton();
}

function renderOptions() {
  if (!options) return;
  const savedValue = $("attraction").value || savedAttraction;
  const attractionToRestore = options.atrativos[savedValue] ? savedValue : (RENAMED_ATTRACTIONS[savedValue] || savedValue);
  populateSelect($("attraction"), Object.keys(options.atrativos).filter((attraction) => ALLOWED_ATTRACTIONS.includes(attraction)), "Selecione o atrativo");
  populateSelect($("state"), options.estados, "Selecione o estado");
  $("attraction").disabled = false;

  if (options.atrativos[attractionToRestore]) {
    $("attraction").value = attractionToRestore;
    savedAttraction = attractionToRestore;
    configureAttraction();
  } else {
    renderIdentification();
  }
}

function updateSaveButton() {
  const config = currentAttraction();
  const type = selected("attendanceType");
  const nationality = selected("nationality");
  const cityRegion = type === "Curitiba e Região Metropolitana";
  const brazilian = nationality === "Brasileiro";
  const needsState = cityRegion || brazilian;
  const groupSize = Number($("groupSize").value);
  const informationRequired = requiresInformation(config);
  const countryIsValid = Boolean(canonicalCountry($("country").value));
  const ready = Boolean(
    config &&
    $("name").value.trim() &&
    type &&
    (cityRegion || nationality) &&
    countryIsValid &&
    (!needsState || $("state").value) &&
    (!informationRequired || selectedInformationItems.length) &&
    (!config.permiteGrupo || (Number.isInteger(groupSize) && groupSize >= 1 && groupSize <= 100))
  );
  $("save").disabled = !ready;
}

function encodePayload(data) {
  let binary = "";
  new TextEncoder().encode(JSON.stringify(data)).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function rpc(action, payload) {
  return new Promise((resolve, reject) => {
    if (!navigator.onLine) return reject(new Error("Sem conexão."));
    const nonce = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => cleanup(new Error("O servidor não respondeu.")), 30000);

    function receive(event) {
      const response = event.data?.resposta;
      if (event.data?.tipo !== "atendimento-pwa" || response?.nonce !== nonce) return;
      cleanup();
      response.sucesso ? resolve(response) : reject(new Error(response.erro || "Falha no servidor."));
    }

    function cleanup(error) {
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      if (error) reject(error);
    }

    window.addEventListener("message", receive);
    const form = document.createElement("form");
    form.method = "POST";
    form.action = GAS_URL;
    form.target = "bridge";
    [["action", action], ["payload", encodePayload(payload || {})], ["origin", location.origin], ["nonce", nonce]].forEach(([name, value]) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    });
    document.body.append(form);
    form.submit();
    form.remove();
  });
}

async function refreshOptions() {
  try {
    options = (await rpc("opcoes", {})).opcoes;
    await writeValue(OPTIONS_STORE, options, "atual");
    renderOptions();
  } catch (error) {
    if (!options) setMessage("Sem opções locais. Conecte este dispositivo uma vez à internet.", true);
  }
}

async function updateStatus() {
  const pending = await pendingRecords();
  const online = navigator.onLine;
  $("network").textContent = online ? "● Online" : "● Offline";
  $("network").className = online ? "online" : "offline";
  $("syncSummary").textContent = pending.length
    ? `${pending.length} atendimento(s) aguardando sincronização`
    : "Todos os atendimentos foram sincronizados";
  show($("syncNow"), online && pending.length > 0);
}

function scheduleRetry() {
  if (retryTimer || !navigator.onLine) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    synchronize();
  }, 60000);
}

async function synchronize() {
  if (syncing || !navigator.onLine) return;
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  syncing = true;
  let failed = false;
  try {
    for (const record of await pendingRecords()) {
      try {
        await rpc("sincronizar", record);
        await removePending(record.idEnvio);
      } catch {
        failed = true;
        break;
      }
    }
  } finally {
    syncing = false;
    updateStatus();
    if (failed) scheduleRetry();
  }
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`;
}

function formData() {
  return {
    idEnvio: newId(),
    criadoEm: new Date().toISOString(),
    atrativo: $("attraction").value,
    nome: $("name").value.trim(),
    tipoAtendimento: selected("attendanceType"),
    nacionalidade: selected("nationality"),
    paisOrigem: canonicalCountry($("country").value),
    estadoOrigem: $("state").value,
    informacoes: selectedInformationItems.map((item) => ({ ...item })),
    quantidadeGrupo: $("groupSize").value,
    observacoes: $("notes").value.trim()
  };
}

function resetForNextAttendance(name, attraction) {
  $("form").reset();
  editingIdentification = false;
  $("name").value = name;
  $("attraction").value = attraction;
  configureAttraction();
  hideCountrySuggestions();
  setMessage();
  updateSaveButton();
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  updateSaveButton();
  if ($("save").disabled) return setMessage("Preencha todos os campos obrigatórios.", true);

  const data = formData();
  await writeValue(QUEUE_STORE, data);
  await writeValue(PREFERENCES_STORE, data.nome, "nome");
  $("formScreen").classList.add("hidden");
  $("successScreen").classList.remove("hidden");
  updateStatus();
  synchronize();

  $("newAttendance").onclick = () => {
    resetForNextAttendance(data.nome, data.atrativo);
    $("successScreen").classList.add("hidden");
    $("formScreen").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
});

$("changeIdentification").addEventListener("click", () => {
  editingIdentification = true;
  renderIdentification();
  $("attraction").focus();
});

$("attraction").addEventListener("change", configureAttraction);
$("name").addEventListener("blur", () => { lockName(); updateSaveButton(); });
$("country").addEventListener("input", () => { renderCountrySuggestions(); updateSaveButton(); });
$("country").addEventListener("blur", () => window.setTimeout(commitTypedCountry, 150));
$("country").addEventListener("keydown", (event) => { if (event.key === "Escape") hideCountrySuggestions(); });
$("information").addEventListener("change", () => {
  const isOther = $("information").value === "Outros";
  show($("otherField"), isOther);
  if (isOther) return $("otherInformation").focus();
  $("otherInformation").value = "";
  addSelectedInformation();
});
$("otherInformation").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addSelectedInformation();
});
$("otherInformation").addEventListener("blur", () => {
  if ($("information").value === "Outros" && $("otherInformation").value.trim()) addSelectedInformation();
});
$("selectedInformations").addEventListener("click", (event) => {
  const remove = event.target.closest("button[data-index]");
  if (!remove) return;
  selectedInformationItems.splice(Number(remove.dataset.index), 1);
  renderSelectedInformations();
  updateSaveButton();
});
document.querySelectorAll('input[name="attendanceType"], input[name="nationality"]').forEach((input) => {
  input.addEventListener("change", () => { configureOrigin(); updateSaveButton(); });
});
["state", "otherInformation", "groupSize", "notes"].forEach((id) => {
  $(id).addEventListener("input", updateSaveButton);
  $(id).addEventListener("change", updateSaveButton);
});

$("syncNow").addEventListener("click", synchronize);
window.addEventListener("online", () => { updateStatus(); refreshOptions(); synchronize(); });
window.addEventListener("offline", updateStatus);

(async () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
  $("name").value = await readValue(PREFERENCES_STORE, "nome") || "";
  if ($("name").value) lockName();
  savedAttraction = await readValue(PREFERENCES_STORE, "atrativo") || localStorage.getItem("atrativo") || "";
  if (savedAttraction) await writeValue(PREFERENCES_STORE, savedAttraction, "atrativo");
  options = await readValue(OPTIONS_STORE, "atual");
  renderOptions();
  updateStatus();
  refreshOptions();
  synchronize();
})();
