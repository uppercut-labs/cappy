/* global document, navigator, setTimeout */
const setup = 'Read https://docs.uppercut-labs.com/cappy/guides/setup-cappy.md and set up Cappy in this game project, following its scope and verification steps.';
const payloads = { setup, endpoint: 'https://cappy.uppercut-labs.com/mcp' };
const dialog = document.querySelector('#prompt-dialog');
const textarea = document.querySelector('#prompt-text');
const status = document.querySelector('#copy-status');
const dialogStatus = document.querySelector('#dialog-status');
const dialogCopy = document.querySelector('#dialog-copy');
let previousFocus;
let currentPayload = setup;

function resetCopyFeedback(button) {
  button.dataset.copyToken = String(Number(button.dataset.copyToken || 0) + 1);
  if (button.dataset.originalLabel) button.textContent = button.dataset.originalLabel;
}

function openPrompt(text, manual = false) {
  currentPayload = text;
  resetCopyFeedback(dialogCopy);
  dialogStatus.textContent = manual ? 'Copy the selected text manually.' : '';
  textarea.value = text;
  document.querySelector('#prompt-count').textContent = `${[...text].length} characters · ${text.trim().split(/\s+/).length} words`;
  if (!dialog.open) { previousFocus = document.activeElement; dialog.showModal(); }
  if (manual) { textarea.focus(); textarea.select(); }
}

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.dataset.originalLabel = button.textContent;
  button.addEventListener('click', async () => {
    resetCopyFeedback(button);
    status.textContent = '';
    const token = button.dataset.copyToken;
    const text = button === dialogCopy ? currentPayload : payloads[button.dataset.copy];
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (button.dataset.copyToken !== token) return;
      button.textContent = 'Copied';
      status.textContent = button.dataset.copy === 'endpoint' ? 'Server URL copied.' : 'Prompt copied.';
      if (dialog.open) dialogStatus.textContent = 'Prompt copied.';
      setTimeout(() => { if (button.dataset.copyToken === token) resetCopyFeedback(button); }, 1800);
    } catch {
      resetCopyFeedback(button);
      status.textContent = "Couldn't access the clipboard.";
      openPrompt(text, true);
    }
  });
});
document.querySelector('#inspect-prompt')?.addEventListener('click', () => openPrompt(setup));
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => previousFocus?.focus());
