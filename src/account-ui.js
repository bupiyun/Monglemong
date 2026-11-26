/** Account controls contain no credentials. The caller applies online game
 * snapshots and switches back to its independent guest save on logout. */
export function mountAccountPanel(container, {
  client, onLogin = () => client.login(), onLogout = () => client.logout(),
  onSync = () => client.initialize(), onDelete = () => client.deleteAccount(),
  getPlayMode = () => 'online',
} = {}) {
  container.innerHTML = `
    <section class="account-panel" aria-labelledby="account-heading">
      <div class="account-heading"><div><h3 id="account-heading">계정과 온라인 저장</h3><p id="account-description"></p></div><span id="account-badge" class="account-badge"></span></div>
      <div id="account-profile" class="account-profile" hidden><strong id="account-name"></strong><span id="account-email"></span></div>
      <p id="account-status" class="account-status" role="status"></p>
      <div class="account-actions">
        <button type="button" id="account-login" class="primary-button">Google로 로그인</button>
        <button type="button" id="account-cancel" class="secondary-button" hidden>로그인 취소</button>
        <button type="button" id="account-sync" class="secondary-button" hidden>온라인 저장 확인</button>
        <button type="button" id="account-logout" class="secondary-button" hidden>로그아웃</button>
      </div>
      <p class="account-note">이 기기의 기존 플레이와 온라인 계정의 진행도는 별도로 보관해요. 로그인할 때 기기 저장을 서버로 덮어쓰지 않아요.</p>
      <p id="account-error" class="account-error" role="alert" hidden></p>
      <button type="button" id="account-delete" class="account-delete" hidden>온라인 계정 삭제</button>
      <div id="account-delete-panel" class="account-delete-panel" hidden>
        <strong>온라인 계정을 삭제할까요?</strong>
        <p>온라인 계정과 진행 기록이 삭제돼요. 되돌릴 수 없으며, 이 기기의 기존 오프라인 저장은 유지돼요.</p>
        <div class="account-actions"><button type="button" id="account-delete-confirm" class="danger-button">계정과 온라인 기록 삭제</button><button type="button" id="account-delete-cancel" class="secondary-button">취소</button></div>
      </div>
    </section>`;
  const find = id => container.querySelector('#' + id);
  let disposed = false;
  let busy = false;
  let message = '';
  let confirmingDelete = false;
  function render() {
    if (disposed) return;
    const session = client.getSession();
    const signedIn = Boolean(session.user);
    const loadingOnline = signedIn && getPlayMode() !== 'online';
    const authenticating = session.status === 'authenticating';
    const checking = session.status === 'checking';
    find('account-badge').textContent = signedIn ? session.user.role === 'admin' ? '관리자 계정' : '온라인 계정' : '기기 플레이';
    find('account-description').textContent = loadingOnline ? '계정에 로그인했어요. 현재는 이 기기의 모험을 플레이 중이에요.'
      : signedIn ? '같은 계정으로 온라인 모험을 이어가요.' : 'Google 계정으로 온라인 모험을 시작해요.';
    find('account-profile').hidden = !signedIn;
    find('account-name').textContent = session.user?.name || '모험가';
    find('account-email').textContent = session.user?.email || '';
    find('account-status').textContent = !session.configured ? '온라인 연결이 아직 준비되지 않았어요. 지금은 이 기기에서 플레이할 수 있어요.'
      : authenticating ? '브라우저에서 Google 로그인을 완료해 주세요.'
      : checking ? '저장된 계정을 확인하고 있어요…'
      : session.status === 'offline' ? '서버 연결을 기다리고 있어요. 다시 연결해 온라인 저장을 확인해 주세요.'
      : loadingOnline ? '온라인 저장을 불러오면 계정의 모험으로 전환돼요. 아직 이 기기의 진행도는 온라인에 저장되지 않아요.'
      : signedIn ? '게임 진행은 서버에서 확인하고 저장해요.' : '로그인하지 않아도 이 기기의 모험은 계속할 수 있어요.';
    find('account-login').hidden = signedIn || authenticating;
    find('account-login').disabled = !session.configured || busy || checking;
    find('account-cancel').hidden = !authenticating;
    find('account-sync').hidden = !signedIn && session.status !== 'offline';
    find('account-sync').textContent = session.status === 'offline' ? '다시 연결' : '온라인 저장 확인';
    find('account-logout').hidden = !signedIn;
    find('account-delete').hidden = !signedIn;
    for (const id of ['account-sync', 'account-logout', 'account-delete', 'account-delete-confirm']) find(id).disabled = busy || checking;
    const error = message || session.error;
    find('account-error').textContent = error || '';
    find('account-error').hidden = !error;
    find('account-delete-panel').hidden = !signedIn || !confirmingDelete;
  }
  async function run(operation) {
    if (busy || disposed) return;
    busy = true; message = ''; render();
    try { await operation(); }
    catch (error) { if (!disposed && !['CANCELLED', 'SESSION_CHANGED'].includes(error.code)) message = error.message || '요청을 완료하지 못했어요.'; }
    finally { if (!disposed) { busy = false; render(); } }
  }
  find('account-login').onclick = () => run(onLogin);
  find('account-cancel').onclick = () => { client.cancelLogin().catch(() => {}); };
  find('account-sync').onclick = () => run(onSync);
  find('account-logout').onclick = () => run(onLogout);
  find('account-delete').onclick = () => { confirmingDelete = true; render(); };
  find('account-delete-cancel').onclick = () => { confirmingDelete = false; render(); };
  find('account-delete-confirm').onclick = () => run(async () => { await onDelete(); confirmingDelete = false; });
  const unsubscribe = client.subscribe(render);
  render();
  return { render, dispose() { disposed = true; unsubscribe(); } };
}
