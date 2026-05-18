const formEl = document.querySelector("#news-form");
const titleEl = document.querySelector("#title");
const urlEl = document.querySelector("#url");
const frequencyMinEl = document.querySelector("#frequencyMinSeconds");
const frequencyMaxEl = document.querySelector("#frequencyMaxSeconds");
const addBtn = document.querySelector("#add-btn");
const reloadBtn = document.querySelector("#reload-btn");
const listEl = document.querySelector("#news-list");
const messageEl = document.querySelector("#message");
const cardTemplate = document.querySelector("#news-card-template");

// Global Settings Selectors
const settingsFormEl = document.querySelector("#settings-form");
const proxyUrlEl = document.querySelector("#proxyUrl");
const saveSettingsBtn = document.querySelector("#save-settings-btn");
const settingsMessageEl = document.querySelector("#settings-message");

// Clash Subscription Selectors
const subscriptionUrlEl = document.querySelector("#subscriptionUrl");
const syncSubBtn = document.querySelector("#sync-sub-btn");
const downloadClashBtn = document.querySelector("#download-clash-btn");

let items = [];

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return new Intl.NumberFormat("zh-CN").format(Number(value));
}

function setMessage(text, type = "muted") {
  messageEl.textContent = text;
  messageEl.dataset.type = type;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.error || "请求失败");
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

function getItem(id) {
  return items.find((item) => item.id === id);
}

function upsertItem(updatedItem) {
  items = items.some((item) => item.id === updatedItem.id)
    ? items.map((item) => (item.id === updatedItem.id ? updatedItem : item))
    : [updatedItem, ...items];
  renderList();
}

let autoRefreshInterval = null;

function startAutoRefresh() {
  if (autoRefreshInterval) return;
  autoRefreshInterval = setInterval(async () => {
    const hasActiveMonitor = items.some((item) => item.monitorEnabled);
    if (hasActiveMonitor) {
      try {
        const { newsItems } = await request("/api/news");
        items = newsItems;
        renderList();
      } catch (error) {
        console.error("Auto refresh failed:", error);
      }
    } else {
      stopAutoRefresh();
    }
  }, 5000);
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

function renderList() {
  listEl.innerHTML = "";

  if (!items.length) {
    listEl.innerHTML = '<p class="empty-state">还没有新闻，先添加一条开始监控。</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    const status = card.querySelector('[data-field="status"]');
    const toggleBtn = card.querySelector('[data-action="toggle"]');
    const fetchBtn = card.querySelector('[data-action="fetch"]');
    const deleteBtn = card.querySelector('[data-action="delete"]');
    const minInput = card.querySelector('[data-field="minSeconds"]');
    const maxInput = card.querySelector('[data-field="maxSeconds"]');
    const durationInput = card.querySelector('[data-field="durationHours"]');

    card.dataset.id = item.id;
    card.querySelector('[data-field="title"]').textContent = item.title || "未命名新闻";
    card.querySelector('[data-field="proxyNode"]').textContent = item.proxyNode || "直连";

    const link = card.querySelector('[data-field="url"]');
    link.href = item.url;
    link.textContent = item.url;

    status.textContent = item.monitorEnabled ? "监控中" : "未开启";
    status.dataset.active = item.monitorEnabled ? "true" : "false";
    if (!item.monitorEnabled && item.monitorStopReason) {
      status.textContent = item.monitorStopReason;
    }

    card.querySelector('[data-field="readCount"]').textContent = formatNumber(item.lastReadCount);
    minInput.value = item.frequencyMinSeconds ?? 1;
    maxInput.value = item.frequencyMaxSeconds ?? 3;
    durationInput.value = item.monitorDurationHours ?? 24;
    minInput.disabled = item.monitorEnabled;
    maxInput.disabled = item.monitorEnabled;
    durationInput.disabled = item.monitorEnabled;

    toggleBtn.textContent = item.monitorEnabled ? "停止监控" : "开始监控";
    toggleBtn.dataset.id = item.id;
    fetchBtn.dataset.id = item.id;
    deleteBtn.dataset.id = item.id;

    fragment.append(card);
  });

  listEl.append(fragment);
}

async function loadItems() {
  // Load settings
  try {
    const settings = await request("/api/settings");
    if (proxyUrlEl) {
      proxyUrlEl.value = settings.proxyUrl || "";
    }
    if (subscriptionUrlEl) {
      subscriptionUrlEl.value = settings.subscriptionUrl || "";
    }
    if (downloadClashBtn) {
      downloadClashBtn.style.display = settings.hasNodes ? "inline-flex" : "none";
    }
  } catch (error) {
    console.error("Failed to load settings:", error);
  }

  const { newsItems } = await request("/api/news");
  items = newsItems;
  renderList();

  // Start auto-refresh if any monitor is active
  if (items.some((item) => item.monitorEnabled)) {
    startAutoRefresh();
  }
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();

  const title = titleEl.value.trim();
  const url = urlEl.value.trim();
  const frequencyMinSeconds = Number(frequencyMinEl.value);
  const frequencyMaxSeconds = Number(frequencyMaxEl.value);

  if (frequencyMaxSeconds < frequencyMinSeconds) {
    setMessage("最大间隔必须大于等于最小间隔。", "error");
    return;
  }

  addBtn.disabled = true;
  addBtn.textContent = "添加并刷新中...";

  try {
    const { item } = await request("/api/news", {
      method: "POST",
      body: JSON.stringify({ title, url, frequencyMinSeconds, frequencyMaxSeconds })
    });
    upsertItem(item);
    formEl.reset();
    frequencyMinEl.value = "1";
    frequencyMaxEl.value = "3";
    setMessage(
      item.lastStatus === "error"
        ? "已添加到列表，但首次读取阅读量被校验拦截。请先停止高频监控，稍后再手动刷新。"
        : "已添加到新闻列表，并完成首次阅读量刷新。",
      item.lastStatus === "error" ? "error" : "success"
    );
  } catch (error) {
    if (error.status === 409 && error.payload?.item) {
      upsertItem(error.payload.item);
    }
    setMessage(error.message, "error");
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = "添加到列表";
  }
});

listEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const item = getItem(button.dataset.id);
  if (!item) return;
  const card = button.closest(".news-card");

  button.disabled = true;
  const originalText = button.textContent;

  try {
    if (button.dataset.action === "toggle") {
      button.textContent = item.monitorEnabled ? "停止中..." : "启动中...";
      const frequencyMinSeconds = Number(card.querySelector('[data-field="minSeconds"]').value);
      const frequencyMaxSeconds = Number(card.querySelector('[data-field="maxSeconds"]').value);
      const monitorDurationHours = Number(card.querySelector('[data-field="durationHours"]').value);

      if (frequencyMaxSeconds < frequencyMinSeconds) {
        throw new Error("最大间隔必须大于等于最小间隔。");
      }

      const { item: updatedItem } = await request(`/api/news/${item.id}/monitor`, {
        method: "POST",
        body: JSON.stringify({
          monitorEnabled: !item.monitorEnabled,
          frequencyMinSeconds,
          frequencyMaxSeconds,
          monitorDurationHours
        })
      });
      upsertItem(updatedItem);
      setMessage(updatedItem.monitorEnabled ? `已开始定时监控阅读量，最多持续 ${updatedItem.monitorDurationHours} 小时。` : "已停止监控。", "success");

      // Start/stop auto-refresh based on whether any monitor is running
      if (items.some((i) => i.monitorEnabled)) {
        startAutoRefresh();
      } else {
        stopAutoRefresh();
      }
    }

    if (button.dataset.action === "fetch") {
      button.textContent = "刷新中...";
      const { item: updatedItem } = await request(`/api/news/${item.id}/fetch`, {
        method: "POST"
      });
      upsertItem(updatedItem);
      setMessage("阅读量已更新。", "success");
    }

    if (button.dataset.action === "delete") {
      button.textContent = "删除中...";
      await request(`/api/news/${item.id}`, { method: "DELETE" });
      items = items.filter((entry) => entry.id !== item.id);
      renderList();
      setMessage("已删除该新闻。", "success");
    }
  } catch (error) {
    setMessage(error.message, "error");
    button.textContent = originalText;
  } finally {
    button.disabled = false;
  }
});

listEl.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-field]");
  if (!input) return;

  const card = input.closest(".news-card");
  if (!card) return;

  const itemId = card.dataset.id;
  const item = getItem(itemId);
  if (!item) return;

  const minInput = card.querySelector('[data-field="minSeconds"]');
  const maxInput = card.querySelector('[data-field="maxSeconds"]');
  const durationInput = card.querySelector('[data-field="durationHours"]');

  const frequencyMinSeconds = Number(minInput.value);
  const frequencyMaxSeconds = Number(maxInput.value);
  const monitorDurationHours = Number(durationInput.value);

  if (frequencyMaxSeconds < frequencyMinSeconds) {
    setMessage("最大间隔必须大于等于最小间隔。", "error");
    minInput.value = item.frequencyMinSeconds ?? 1;
    maxInput.value = item.frequencyMaxSeconds ?? 3;
    return;
  }

  try {
    const { item: updatedItem } = await request(`/api/news/${item.id}/monitor`, {
      method: "POST",
      body: JSON.stringify({
        frequencyMinSeconds,
        frequencyMaxSeconds,
        monitorDurationHours
      })
    });
    // Silent update the local item reference without triggering full renderList (preventing layout/focus jumps)
    items = items.map((i) => (i.id === updatedItem.id ? updatedItem : i));
    setMessage("设置已自动保存。", "success");
  } catch (error) {
    setMessage(error.message, "error");
    minInput.value = item.frequencyMinSeconds ?? 1;
    maxInput.value = item.frequencyMaxSeconds ?? 3;
    durationInput.value = item.monitorDurationHours ?? 24;
  }
});

reloadBtn.addEventListener("click", async () => {
  reloadBtn.disabled = true;
  reloadBtn.textContent = "刷新中...";
  try {
    await loadItems();
    setMessage("列表已刷新。", "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    reloadBtn.disabled = false;
    reloadBtn.textContent = "刷新列表";
  }
});

if (settingsFormEl) {
  settingsFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const proxyUrl = proxyUrlEl.value.trim();
    const subscriptionUrl = subscriptionUrlEl.value.trim();

    saveSettingsBtn.disabled = true;
    saveSettingsBtn.textContent = "保存中...";
    settingsMessageEl.textContent = "";

    try {
      const settings = await request("/api/settings", {
        method: "POST",
        body: JSON.stringify({ proxyUrl, subscriptionUrl })
      });
      proxyUrlEl.value = settings.proxyUrl || "";
      subscriptionUrlEl.value = settings.subscriptionUrl || "";
      settingsMessageEl.textContent = "全局设置已成功保存！";
      settingsMessageEl.dataset.type = "success";
    } catch (error) {
      settingsMessageEl.textContent = error.message;
      settingsMessageEl.dataset.type = "error";
    } finally {
      saveSettingsBtn.disabled = false;
      saveSettingsBtn.textContent = "保存设置";
    }
  });
}

if (syncSubBtn) {
  syncSubBtn.addEventListener("click", async () => {
    const subscriptionUrl = subscriptionUrlEl.value.trim();
    if (!subscriptionUrl) {
      settingsMessageEl.textContent = "请先填写订阅链接。";
      settingsMessageEl.dataset.type = "error";
      return;
    }

    syncSubBtn.disabled = true;
    syncSubBtn.textContent = "同步中...";
    settingsMessageEl.textContent = "";

    try {
      const result = await request("/api/settings/import-subscription", {
        method: "POST",
        body: JSON.stringify({ subscriptionUrl })
      });
      settingsMessageEl.textContent = `成功同步！已解析 ${result.totalNodes} 个独占代理节点。`;
      settingsMessageEl.dataset.type = "success";
      if (downloadClashBtn) {
        downloadClashBtn.style.display = "inline-flex";
      }
      await loadItems();
    } catch (error) {
      settingsMessageEl.textContent = error.message;
      settingsMessageEl.dataset.type = "error";
    } finally {
      syncSubBtn.disabled = false;
      syncSubBtn.textContent = "同步节点";
    }
  });
}

loadItems().catch((error) => {
  setMessage(error.message, "error");
});
