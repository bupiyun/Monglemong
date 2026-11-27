/** Password fields are transient. The caller switches between the independent
 * device save and the account game after a successful account operation. */
export function mountAccountPanel(container, {
  client, onLogin = credentials => client.login(credentials),
  onRegister = credentials => client.register(credentials),
  onChangePassword = credentials => client.changePassword(credentials),
  onLogout = () => client.logout(), onSync = () => client.initialize(),
  onDelete = credentials => client.deleteAccount(credentials), getPlayMode = () => 'online',
} = {}) {
  container.innerHTML = `
    <section class="account-panel" aria-labelledby="account-heading">
      <div class="account-heading"><div><h3 id="account-heading">계정과 온라인 저장</h3><p id="account-description"></p></div><span id="account-badge" class="account-badge"></span></div>
      <div id="account-profile" class="account-profile" hidden><strong id="account-name"></strong><span id="account-email"></span></div>
      <p id="account-status" class="account-status" role="status"></p>
      <form id="account-auth-form" class="account-form" novalidate>
        <div class="account-mode" role="group" aria-label="계정 시작 방법"><button type="button" id="account-auth-mode-login" aria-pressed="true">로그인</button><button type="button" id="account-auth-mode-register" aria-pressed="false">회원가입</button></div>
        <label for="account-username">아이디<input id="account-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="4" maxlength="32" required aria-describedby="account-username-hint"></label>
        <small id="account-username-hint">영문 소문자로 시작하는 4~32자의 소문자·숫자·밑줄</small>
        <label id="account-register-name-row" for="account-register-name" hidden>표시 이름 <span>(선택)</span><input id="account-register-name" name="name" autocomplete="nickname" maxlength="80"></label>
        <label for="account-password">비밀번호<input id="account-password" name="password" type="password" autocomplete="current-password" maxlength="256" required aria-describedby="account-password-hint"></label>
        <small id="account-password-hint">6자 이상, 최대 72바이트 (한글 등은 여러 바이트를 사용해요)</small>
        <label id="account-password-confirm-row" for="account-password-confirm" hidden>비밀번호 확인<input id="account-password-confirm" type="password" autocomplete="new-password" maxlength="256"></label>
        <div class="account-actions"><button type="submit" id="account-login" class="primary-button">로그인</button><button type="submit" id="account-register" class="primary-button" hidden>회원가입하고 시작하기</button></div>
        <p class="account-note">비밀번호를 잊었다면 운영자에게 계정 복구를 문의해 주세요.</p>
      </form>
      <div class="account-actions">
        <button type="button" id="account-cancel" class="secondary-button" hidden>로그인 취소</button>
        <button type="button" id="account-sync" class="secondary-button" hidden>온라인 저장 확인</button>
        <button type="button" id="account-logout" class="secondary-button" hidden>로그아웃</button>
        <button type="button" id="account-password-open" class="secondary-button" hidden>비밀번호 변경</button>
      </div>
      <form id="account-password-panel" class="account-form account-security-panel" hidden novalidate>
        <strong>비밀번호 변경</strong><p>변경하면 다른 기기의 로그인은 해제돼요.</p>
        <label for="account-current-password">현재 비밀번호<input id="account-current-password" type="password" autocomplete="current-password" maxlength="256" required></label>
        <label for="account-new-password">새 비밀번호<input id="account-new-password" type="password" autocomplete="new-password" maxlength="256" required></label>
        <label for="account-new-password-confirm">새 비밀번호 확인<input id="account-new-password-confirm" type="password" autocomplete="new-password" maxlength="256" required></label>
        <small>6자 이상, 최대 72바이트</small>
        <div class="account-actions"><button type="submit" id="account-password-submit" class="primary-button">비밀번호 저장</button><button type="button" id="account-password-cancel" class="secondary-button">취소</button></div>
      </form>
      <p class="account-note">이 기기의 기존 플레이와 온라인 계정의 진행도는 별도로 보관해요. 로그인할 때 기기 저장을 서버로 덮어쓰지 않아요.</p>
      <p id="account-message" class="account-message" role="status" hidden></p>
      <p id="account-error" class="account-error" role="alert" hidden></p>
      <button type="button" id="account-delete" class="account-delete" hidden>온라인 계정 삭제</button>
      <form id="account-delete-panel" class="account-form account-delete-panel" hidden novalidate>
        <strong>온라인 계정을 삭제할까요?</strong>
        <p>온라인 계정과 진행 기록이 삭제돼요. 되돌릴 수 없으며, 이 기기의 기존 오프라인 저장은 유지돼요.</p>
        <label for="account-delete-password">현재 비밀번호<input id="account-delete-password" type="password" autocomplete="current-password" maxlength="256" required></label>
        <div class="account-actions"><button type="submit" id="account-delete-confirm" class="danger-button">계정과 온라인 기록 삭제</button><button type="button" id="account-delete-cancel" class="secondary-button">취소</button></div>
      </form>
    </section>`;
  const find = id => container.querySelector('#' + id);
  let disposed = false, busy = false, confirmingDelete = false, changingPassword = false;
  let mode = 'login', message = '', notice = '';
  const clearPasswords = () => { for (const input of container.querySelectorAll('input[type="password"]')) input.value = ''; };
  function passwordError(password) {
    return typeof password !== 'string' || password.includes('\0') || [...password].length < 6 || new TextEncoder().encode(password).length > 72
      ? '비밀번호는 6자 이상, 최대 72바이트로 입력해 주세요.' : '';
  }
  function showValidation(error) { message = error; notice = ''; clearPasswords(); render(); }
  function render() {
    if (disposed) return;
    const session = client.getSession();
    const signedIn = Boolean(session.user);
    const loadingOnline = signedIn && getPlayMode() !== 'online';
    const authenticating = session.status === 'authenticating';
    const checking = session.status === 'checking';
    find('account-badge').textContent = signedIn ? session.user.role === 'admin' ? '관리자 계정' : '온라인 계정' : '기기 플레이';
    find('account-description').textContent = loadingOnline ? '계정에 로그인했어요. 현재는 이 기기의 모험을 플레이 중이에요.'
      : signedIn ? '같은 계정으로 온라인 모험을 이어가요.' : '몽글몽 아이디로 온라인 모험을 시작해요.';
    find('account-profile').hidden = !signedIn;
    find('account-name').textContent = session.user?.name || '모험가';
    find('account-email').textContent = session.user?.username ? '아이디: ' + session.user.username : '';
    find('account-status').textContent = !session.configured ? '온라인 연결이 아직 준비되지 않았어요. 지금은 이 기기에서 플레이할 수 있어요.'
      : authenticating ? '계정을 확인하고 있어요…'
      : checking ? '저장된 계정을 확인하고 있어요…'
      : session.status === 'offline' ? '서버 연결을 기다리고 있어요. 다시 연결해 온라인 저장을 확인해 주세요.'
      : loadingOnline ? '온라인 저장을 불러오면 계정의 모험으로 전환돼요. 아직 이 기기의 진행도는 온라인에 저장되지 않아요.'
      : signedIn ? '게임 진행은 서버에서 확인하고 저장해요.' : '로그인하지 않아도 이 기기의 모험은 계속할 수 있어요.';
    find('account-auth-form').hidden = signedIn;
    find('account-register-name-row').hidden = mode !== 'register';
    find('account-password-confirm-row').hidden = mode !== 'register';
    find('account-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    find('account-login').hidden = mode !== 'login';
    find('account-register').hidden = mode !== 'register';
    for (const selected of ['login', 'register']) find('account-auth-mode-' + selected).setAttribute('aria-pressed', String(mode === selected));
    for (const control of find('account-auth-form').querySelectorAll('input,button')) control.disabled = !session.configured || busy || checking;
    find('account-cancel').hidden = !authenticating;
    find('account-sync').hidden = !signedIn && session.status !== 'offline';
    find('account-sync').textContent = session.status === 'offline' ? '다시 연결' : '온라인 저장 확인';
    for (const id of ['account-logout', 'account-delete', 'account-password-open']) find(id).hidden = !signedIn;
    for (const id of ['account-sync', 'account-logout', 'account-delete', 'account-password-open']) find(id).disabled = busy || checking;
    for (const panel of ['account-delete-panel', 'account-password-panel']) for (const control of find(panel).querySelectorAll('input,button')) control.disabled = busy || checking;
    const error = message || session.error;
    find('account-error').textContent = error || '';
    find('account-error').hidden = !error;
    find('account-message').textContent = notice;
    find('account-message').hidden = !notice;
    find('account-delete-panel').hidden = !signedIn || !confirmingDelete;
    find('account-password-panel').hidden = !signedIn || !changingPassword;
  }
  async function run(operation) {
    if (busy || disposed) return false;
    busy = true; message = ''; notice = ''; render();
    try { await operation(); return true; }
    catch (error) { if (!disposed && !['CANCELLED', 'SESSION_CHANGED'].includes(error.code)) message = error.message || '요청을 완료하지 못했어요.'; return false; }
    finally { clearPasswords(); if (!disposed) { busy = false; render(); } }
  }
  for (const selected of ['login', 'register']) find('account-auth-mode-' + selected).onclick = () => {
    mode = selected; message = ''; notice = ''; clearPasswords(); render();
  };
  find('account-auth-form').onsubmit = event => {
    event.preventDefault();
    if (busy || disposed) return;
    const username = find('account-username').value.trim(), password = find('account-password').value;
    const confirmation = find('account-password-confirm').value, name = find('account-register-name').value.trim();
    clearPasswords();
    const error = !/^[a-z][a-z0-9_]{3,31}$/.test(username) ? '아이디는 영문 소문자로 시작하는 4~32자의 소문자·숫자·밑줄로 입력해 주세요.'
      : passwordError(password) || (mode === 'register' && password !== confirmation ? '비밀번호 확인이 일치하지 않아요.'
      : mode === 'register' && name && [...name].length > 40 ? '표시 이름은 40자 이하로 입력해 주세요.' : '');
    if (error) { showValidation(error); return; }
    void run(() => mode === 'register' ? onRegister({ username, password, ...(name ? { name } : {}) }) : onLogin({ username, password }));
  };
  find('account-cancel').onclick = () => { clearPasswords(); client.cancelLogin().catch(() => {}); };
  find('account-sync').onclick = () => run(onSync);
  find('account-logout').onclick = () => { clearPasswords(); confirmingDelete = false; changingPassword = false; void run(onLogout); };
  find('account-password-open').onclick = () => { clearPasswords(); changingPassword = true; confirmingDelete = false; notice = ''; render(); };
  find('account-password-cancel').onclick = () => { clearPasswords(); changingPassword = false; render(); };
  find('account-password-panel').onsubmit = event => {
    event.preventDefault();
    if (busy || disposed) return;
    const currentPassword = find('account-current-password').value, newPassword = find('account-new-password').value;
    const confirmation = find('account-new-password-confirm').value;
    clearPasswords();
    const error = passwordError(currentPassword) || passwordError(newPassword) || (newPassword !== confirmation ? '새 비밀번호 확인이 일치하지 않아요.' : '');
    if (error) { showValidation(error); return; }
    void run(async () => {
      await onChangePassword({ currentPassword, newPassword });
      changingPassword = false; notice = '비밀번호를 변경했어요. 다른 기기에서는 새 비밀번호로 로그인해 주세요.';
    });
  };
  find('account-delete').onclick = () => { clearPasswords(); confirmingDelete = true; changingPassword = false; notice = ''; render(); };
  find('account-delete-cancel').onclick = () => { clearPasswords(); confirmingDelete = false; render(); };
  find('account-delete-panel').onsubmit = event => {
    event.preventDefault();
    if (busy || disposed) return;
    const password = find('account-delete-password').value;
    clearPasswords();
    const error = passwordError(password);
    if (error) { showValidation(error); return; }
    void run(async () => { await onDelete({ password }); confirmingDelete = false; });
  };
  const unsubscribe = client.subscribe(render);
  render();
  return { render, dispose() { clearPasswords(); disposed = true; unsubscribe(); } };
}
