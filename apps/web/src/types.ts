export type View = 'servers' | 'analytics' | 'settings';
export type Theme = 'light' | 'dark';

export interface JsonSchema {
  type?: string;
  properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
  required?: string[];
}
