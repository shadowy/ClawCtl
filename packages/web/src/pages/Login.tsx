import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { ShieldCheck } from "lucide-react";

export function Login() {
  const { t } = useTranslation();
  const { login, setup, needsSetup } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (needsSetup) {
        await setup(username, password);
      } else {
        await login(username, password);
      }
    } catch (err: any) {
      setError(err.message || t("login.loginFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-deep flex items-center justify-center relative overflow-hidden">
      {/* Background gradient orb */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-brand/[0.03] blur-[120px] pointer-events-none" />

      <div className="w-full max-w-sm relative z-10">
        {/* Brand */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight mb-1">
            <span className="text-brand">Claw</span>
            <span className="text-ink">Ctl</span>
          </h1>
          <p className="text-sm text-ink-3">{t("login.subtitle")}</p>
        </div>

        {/* Card */}
        <div className="bg-s1 border border-edge rounded-card p-6 shadow-card">
          <p className="text-sm text-ink-2 mb-5">
            {needsSetup ? t("login.setupPrompt") : t("login.signInPrompt")}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-ink-3 mb-1.5 font-medium uppercase tracking-wide">{t("login.usernameLabel")}</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-s2 border border-edge rounded-lg px-3 py-2.5 text-sm text-ink placeholder:text-ink-3 focus:border-brand transition-colors"
                autoFocus
                required
              />
            </div>
            <div>
              <label className="block text-xs text-ink-3 mb-1.5 font-medium uppercase tracking-wide">{t("login.passwordLabel")}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-s2 border border-edge rounded-lg px-3 py-2.5 text-sm text-ink placeholder:text-ink-3 focus:border-brand transition-colors"
                required
                minLength={6}
              />
              {needsSetup && (
                <p className="text-xs text-ink-3 mt-1.5">{t("login.passwordHint")}</p>
              )}
            </div>

            {error && (
              <p className="text-sm text-danger">{error}</p>
            )}

            <button
              type="submit"
              disabled={submitting || !username || !password}
              className="w-full px-4 py-2.5 bg-brand hover:bg-brand-light rounded-lg text-sm text-white font-semibold disabled:opacity-40 transition-colors shadow-glow-brand"
            >
              {submitting ? "..." : needsSetup ? t("login.createAdmin") : t("login.signIn")}
            </button>
          </form>
        </div>

        {needsSetup && (
          <div className="flex items-center justify-center gap-1.5 mt-5 text-xs text-ink-3">
            <ShieldCheck size={12} />
            <span>{t("login.firstRunNote")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
