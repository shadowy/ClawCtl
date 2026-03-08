import { useState } from "react";
import { Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Sidebar } from "./Sidebar";
import { GlobalAssistant } from "./AssistantPanel";
import { useAuth } from "../hooks/useAuth";
import { LogOut } from "lucide-react";

export function Layout() {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const { user, logout } = useAuth();

  return (
    <div className="flex h-screen bg-base text-ink">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-12 border-b border-edge flex items-center justify-end px-5 gap-3 shrink-0 bg-deep/50">
          {user && (
            <>
              <span className="text-xs text-ink-2 font-medium">
                {user.username}
              </span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase ${
                user.role === "admin" ? "bg-brand-dim text-brand" :
                user.role === "operator" ? "bg-cyan-dim text-cyan" :
                "bg-s2 text-ink-3"
              }`}>{user.role}</span>
              <button onClick={logout} className="text-ink-3 hover:text-ink transition-colors p-1 rounded hover:bg-s1" title={t("layout.logout")}>
                <LogOut size={14} />
              </button>
            </>
          )}
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
      <GlobalAssistant />
    </div>
  );
}
