import { createContext, useContext } from 'react';

export const FieldContext = createContext<{ id: string; hintId: string; errorId: string; describedBy?: string; invalid?: boolean } | null>(null);
export function useField() { return useContext(FieldContext); }
