/**
 * sessionStore — Session list state (Zustand)
 * 
 * Manages:
 * - Sessions grouped by workspace
 * - Active session
 * - Activity badges
 */

import { create } from 'zustand';

export type SessionActivityState = 'working' | 'done' | 'failed' | 'idle' | 'paused';

export interface Session {
  id: string;
  title: string;
  timestamp: number;
  messageCount: number;
  state: SessionActivityState;
  pinned?: boolean;
  forkedFrom?: string;
  workspaceId: string;
}

export interface Workspace {
  id: string;
  name: string;
  sessionIds: string[];
}

export interface SessionState {
  // Data
  sessions: Record<string, Session>;
  workspaces: Record<string, Workspace>;
  workspaceOrder: string[];

  // Active
  activeSessionId: string | null;
  activeWorkspaceId: string | null;

  // Filters
  searchQuery: string;

  // Actions
  setSessions: (sessions: Session[]) => void;
  addSession: (session: Session) => void;
  updateSession: (id: string, updates: Partial<Session>) => void;
  removeSession: (id: string) => void;

  setWorkspaces: (workspaces: Workspace[]) => void;

  setActiveSession: (id: string | null) => void;
  setActiveWorkspace: (id: string | null) => void;

  pinSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;

  setSearchQuery: (query: string) => void;

  // Computed
  getSessionsByWorkspace: (workspaceId: string) => Session[];
  getActiveSession: () => Session | null;
  getFilteredSessions: () => Session[];
}

export const useSessionStore = create<SessionState>((set, get) => ({
  // Data
  sessions: {},
  workspaces: {},
  workspaceOrder: [],

  // Active
  activeSessionId: null,
  activeWorkspaceId: null,

  // Filters
  searchQuery: '',

  // ─── Actions ────────────────────────────────────────────
  setSessions: (sessions) =>
    set({
      sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    }),

  addSession: (session) =>
    set((state) => ({
      sessions: { ...state.sessions, [session.id]: session },
    })),

  updateSession: (id, updates) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [id]: state.sessions[id] ? { ...state.sessions[id], ...updates } : ({} as Session),
      },
    })),

  removeSession: (id) =>
    set((state) => {
      const { [id]: _, ...rest } = state.sessions;
      return {
        sessions: rest,
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
      };
    }),

  setWorkspaces: (workspaces) =>
    set({
      workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w])),
      workspaceOrder: workspaces.map((w) => w.id),
    }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

  pinSession: (id) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [id]: state.sessions[id]
          ? { ...state.sessions[id], pinned: !state.sessions[id].pinned }
          : ({} as Session),
      },
    })),

  renameSession: (id, title) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [id]: state.sessions[id]
          ? { ...state.sessions[id], title }
          : ({} as Session),
      },
    })),

  setSearchQuery: (query) => set({ searchQuery: query }),

  // ─── Computed ───────────────────────────────────────────
  getSessionsByWorkspace: (workspaceId) => {
    const state = get();
    const workspace = state.workspaces[workspaceId];
    if (!workspace) return [];
    return workspace.sessionIds
      .map((id) => state.sessions[id])
      .filter(Boolean)
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.timestamp - a.timestamp;
      });
  },

  getActiveSession: () => {
    const state = get();
    return state.activeSessionId ? state.sessions[state.activeSessionId] || null : null;
  },

  getFilteredSessions: () => {
    const state = get();
    const query = state.searchQuery.toLowerCase();
    if (!query) return Object.values(state.sessions);
    return Object.values(state.sessions).filter((s) =>
      s.title.toLowerCase().includes(query)
    );
  },
}));

export default useSessionStore;
