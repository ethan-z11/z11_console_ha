import { LogIn, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, login as loginApi, setupAdmin as setupApi } from '../consoleApi';
import type { LoginResult } from '../consoleApi';

interface LoginPageProps {
  /** 登录成功后通知父组件刷新 /api/admin/me。 */
  onAuthenticated: () => void;
}

/** 登录页：账号 + 密码 + 记住登录（默认勾选，30 天免重新输入）。 */
export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const formId = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => { document.title = '家庭控制'; }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (checking) return;
    setError(null);
    const u = username.trim();
    const p = password;
    if (!u || !p) { setError('请输入账号和密码'); return; }
    setChecking(true);
    const result: LoginResult = await loginApi(u, p, remember).catch((reason: Error) => ({ ok: false as const, message: reason.message }));
    setChecking(false);
    if (result.ok) {
      onAuthenticated();
      return;
    }
    setError(result.message);
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-card__heading">
          <span className="tile__chip"><LogIn size={22} /></span>
          <div>
            <h1>家庭控制</h1>
            <p>请输入账号和密码进入控制台</p>
          </div>
        </div>
        <label className="settings-field" htmlFor={`${formId}-username`}>
          <span>账号</span>
          <input id={`${formId}-username`} type="text" autoComplete="username" spellCheck={false} value={username}
                 onChange={(event) => setUsername(event.target.value)} disabled={checking} placeholder="admin" />
        </label>
        <label className="settings-field" htmlFor={`${formId}-password`}>
          <span>密码</span>
          <input id={`${formId}-password`} type="password" autoComplete="current-password" value={password}
                 onChange={(event) => setPassword(event.target.value)} disabled={checking} />
        </label>
        <label className="auth-card__remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={checking} />
          <span>记住登录（30 天内免重新输入）</span>
        </label>
        {error && <p className="settings-message settings-message--error" role="alert">{error}</p>}
        <div className="settings-actions">
          <button type="submit" className="small-button small-button--selected" disabled={checking}>
            {checking ? '正在登录…' : '登录'}
          </button>
        </div>
      </form>
    </div>
  );
}

interface SetupPageProps {
  /** 完成引导后通知父组件刷新 /api/admin/me（用新账号重新签发会话）。 */
  onCompleted: () => void;
  /** 取消引导，回到主界面（仍以 admin/admin 登录状态使用）。 */
  onCancel: () => void;
  /** 当前管理员账号名（默认 admin），用于预填与冲突提示。 */
  currentUsername: string;
}

/** 管理员修改：首次进入时管理员改账户名 + 密码；完成后 setupCompleted=true，账户名锁定。 */
export function SetupPage({ onCompleted, onCancel, currentUsername }: SetupPageProps) {
  const formId = useId();
  const [username, setUsername] = useState(currentUsername);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError(null);
    const u = username.trim();
    if (u.length < 2 || u.length > 32 || !/^[A-Za-z0-9_.@-]+$/.test(u)) {
      setError('账号需 2–32 位，仅字母、数字、下划线、点、@ 或连字符'); return;
    }
    if (password.length < 4 || password.length > 128) { setError('密码需 4–128 位'); return; }
    if (password !== confirm) { setError('两次输入的密码不一致'); return; }
    setSaving(true);
    try {
      await setupApi(u, password);
      onCompleted();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError((err as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-card__heading">
          <span className="tile__chip"><ShieldCheck size={22} /></span>
          <div>
            <h1>管理员修改</h1>
            <p>修改管理员账号与密码，完成后账号名将锁定，仅可在设置中改密码</p>
          </div>
        </div>
        <p className="auth-card__hint">请将默认 admin/admin 改为你自己的账号与密码。</p>
        <label className="settings-field" htmlFor={`${formId}-username`}>
          <span>新账号</span>
          <input id={`${formId}-username`} type="text" autoComplete="username" spellCheck={false} value={username}
                 onChange={(event) => setUsername(event.target.value)} disabled={saving} />
        </label>
        <label className="settings-field" htmlFor={`${formId}-password`}>
          <span>新密码</span>
          <input id={`${formId}-password`} type="password" autoComplete="new-password" value={password}
                 onChange={(event) => setPassword(event.target.value)} disabled={saving} />
        </label>
        <label className="settings-field" htmlFor={`${formId}-confirm`}>
          <span>确认新密码</span>
          <input id={`${formId}-confirm`} type="password" autoComplete="new-password" value={confirm}
                 onChange={(event) => setConfirm(event.target.value)} disabled={saving} />
        </label>
        {error && <p className="settings-message settings-message--error" role="alert">{error}</p>}
        <div className="settings-actions">
          <button type="submit" className="small-button small-button--selected" disabled={saving}>
            {saving ? '正在保存…' : '完成修改'}
          </button>
          <button type="button" className="small-button" onClick={onCancel} disabled={saving}>稍后再说</button>
        </div>
      </form>
    </div>
  );
}
