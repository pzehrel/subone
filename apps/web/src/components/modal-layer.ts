import { createContext } from 'react';
import type { RefObject } from 'react';

export const ModalLayerContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
