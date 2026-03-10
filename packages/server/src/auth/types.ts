export type Role = "admin" | "operator" | "auditor";

export interface User {
  id: number;
  username: string;
  role: Role;
  created_at: string;
  last_login: string | null;
}

export interface UserRow extends User {
  password_hash: string;
  salt: string;
}

export interface SessionPayload {
  userId: number;
  username: string;
  role: Role;
}

// Role permission matrix
// admin: full access
// operator: read + write instances/config/tools/operations, no user management or system settings
// auditor: read-only everything, no writes
export const ROLE_PERMISSIONS: Record<Role, { read: string[]; write: string[] }> = {
  admin: {
    read: ["*"],
    write: ["*"],
  },
  operator: {
    read: ["*"],
    write: ["instances", "config", "tools", "operations", "digest", "sessions", "lifecycle", "security", "skills"],
  },
  auditor: {
    read: ["*"],
    write: [],
  },
};
