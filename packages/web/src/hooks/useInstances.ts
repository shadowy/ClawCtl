import { useState, useEffect, useCallback } from "react";
import { get, post, del } from "../lib/api";

export interface InstanceInfo {
  id: string;
  connection: {
    id: string;
    url: string;
    label?: string;
    status: string;
    error?: string;
  };
  version?: string;
  health?: { status: string; version?: string };
  agents: { id: string; name?: string; model?: string; thinking?: string; toolsAllow?: string[]; execSecurity?: { security?: string; host?: string; ask?: string; workspaceOnly?: boolean }; isDefault?: boolean }[];
  channels: { type: string; accountId?: string; enabled: boolean; running: boolean }[];
  sessions: { key: string; kind: string; model?: string; displayName?: string; alias?: string; channel?: string; updatedAt?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheRead?: number; cacheWrite?: number }[];
  skills: { name: string; status: string; description?: string }[];
  config?: Record<string, unknown>;
  securityAudit?: { level: string; title: string; detail: string; fix?: string }[];
}

export function useInstances() {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    get<InstanceInfo[]>("/instances")
      .then(setInstances)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const addInstance = useCallback(async (url: string, token?: string, label?: string) => {
    await post("/instances", { url, token, label });
    refresh();
  }, [refresh]);

  const removeInstance = useCallback(async (id: string) => {
    await del(`/instances/${id}`);
    refresh();
  }, [refresh]);

  return { instances, loading, refresh, addInstance, removeInstance };
}
