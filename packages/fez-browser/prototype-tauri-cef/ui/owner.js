const invoke = (action, fields = {}) => window.__TAURI__.core.invoke('native_surface_owner', { action, ...fields });
const status = document.querySelector('#state'), control = document.querySelector('#control'), waiting = document.querySelector('#waiting');
let nextAction = 'grant', surfaceId;
function show(state) {
  if (surfaceId !== undefined && state.id !== surfaceId) return;
  surfaceId = state.id;
  const lead = state.mode === 'agent' ? `${state.agentName ? '@' + state.agentName : 'Agent'} driving`
    : state.paused ? 'You have control' : state.queued ? 'Ready for attached agents' : 'You have control';
  status.textContent = lead;
  status.title = status.textContent;
  waiting.replaceChildren();
  for (const entry of state.waitingEntries ?? (state.waiting ?? []).map(persona => ({ persona }))) {
    const chip = document.createElement('span');
    chip.className = 'waiter'; chip.textContent = `@${entry.persona} waiting`;
    if (entry.request) {
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.textContent = '×';
      cancel.setAttribute('aria-label', `Cancel @${entry.persona} waiting`);
      cancel.title = `Cancel @${entry.persona} waiting`;
      cancel.onclick = () => {
        cancel.disabled = true;
        void invoke('cancel', { request: entry.request, persona: entry.persona }).then(show).catch(error => { cancel.disabled = false; report(error); });
      };
      chip.append(cancel);
    }
    waiting.append(chip);
  }
  nextAction = state.queued ? (state.paused ? 'resume' : 'take') : (state.mode === 'agent' ? 'take' : 'grant');
  control.textContent = nextAction === 'take' ? 'Take control' : nextAction === 'resume' ? 'Resume agents' : 'Give agent control';
  control.disabled = state.mode === 'stopped';
}
const report = error => { status.textContent = String(error); };
control.onclick = () => invoke(nextAction).then(show).catch(report);
document.querySelector('#stop').onclick = () => invoke('stop').catch(report);
window.__TAURI__.event.listen('native-surface', ({ payload }) => {
  if (surfaceId !== undefined && payload.id === surfaceId) show(payload);
}).then(() => invoke('state')).then(show).catch(report);
