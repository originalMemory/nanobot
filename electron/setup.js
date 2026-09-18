const form = document.getElementById('connection');
const input = document.getElementById('gateway');
const error = document.getElementById('error');
const button = form.querySelector('button');
const controls = window.desktopSetup.windowControls;
document.getElementById('window-buttons').hidden = controls.isMac;
document.querySelectorAll('[data-action]').forEach((item) => {
  item.addEventListener('click', () => void controls.action(item.dataset.action));
});
const updateWindow = (maximized) => {
  const item = document.querySelector('[data-action="maximize"]');
  item.textContent = maximized ? '❐' : '□';
  item.setAttribute('aria-label', maximized ? '还原' : '最大化');
};
void controls.read().then(updateWindow);
controls.onState(updateWindow);
window.desktopSetup.read().then((state) => { input.value = state.gateway; error.textContent = state.error; });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  error.textContent = '';
  try {
    const result = await window.desktopSetup.connect(input.value);
    if (!result.ok) error.textContent = result.error;
  } catch { error.textContent = '连接失败，请重试。'; }
  finally { button.disabled = false; }
});
