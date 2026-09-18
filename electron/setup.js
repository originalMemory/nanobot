const form = document.getElementById('connection');
const input = document.getElementById('gateway');
const error = document.getElementById('error');
const button = form.querySelector('button');
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
