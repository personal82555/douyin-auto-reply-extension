// 一键打开侧边面板
document.getElementById("open").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    // 部分旧版本浏览器不支持 open by tabId, 退回 options 式
    console.warn(e);
  }
  window.close();
});
