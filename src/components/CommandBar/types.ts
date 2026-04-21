export type Category = 'NAV' | 'AI' | 'SYSTEM' | 'POWER';

export type Command = {
  readonly id: string;
  readonly title: string;
  readonly category: Category;
  readonly run: () => void | Promise<void>;
};
