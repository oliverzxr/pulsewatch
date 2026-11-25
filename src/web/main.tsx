import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import { SessionGate } from './Session.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><SessionGate /></StrictMode>);
