import { create } from 'zustand';

export type Task = {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: number;
};

type State = {
  tasks: ReadonlyArray<Task>;
  addTask: (text: string) => void;
  toggleTask: (id: string) => void;
  deleteTask: (id: string) => void;
  clearCompleted: () => void;
};

const STORAGE_KEY = 'sunny.tasks.v1';

function isTask(raw: unknown): raw is Task {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.text === 'string' &&
    typeof r.done === 'boolean' &&
    typeof r.createdAt === 'number'
  );
}

function loadTasks(): ReadonlyArray<Task> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Legacy entries that don't match the minimal shape are discarded.
    return parsed.filter(isTask);
  } catch (error) {
    console.error('Failed to load tasks:', error);
    return [];
  }
}

function persist(tasks: ReadonlyArray<Task>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (error) {
    console.error('Failed to persist tasks:', error);
  }
}

function makeId(): string {
  // Prefer crypto.randomUUID per spec; fall back if unavailable.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export const useTasks = create<State>((set, get) => ({
  tasks: loadTasks(),
  addTask: text => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const task: Task = {
      id: makeId(),
      text: trimmed,
      done: false,
      createdAt: Date.now(),
    };
    const next: ReadonlyArray<Task> = [task, ...get().tasks];
    persist(next);
    set({ tasks: next });
  },
  toggleTask: id => {
    const next = get().tasks.map(t =>
      t.id === id ? { ...t, done: !t.done } : t,
    );
    persist(next);
    set({ tasks: next });
  },
  deleteTask: id => {
    const next = get().tasks.filter(t => t.id !== id);
    persist(next);
    set({ tasks: next });
  },
  clearCompleted: () => {
    const next = get().tasks.filter(t => !t.done);
    persist(next);
    set({ tasks: next });
  },
}));
