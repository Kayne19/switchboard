import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ControllerProvider } from './controller/context';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ControllerProvider>
      <App />
    </ControllerProvider>
  </StrictMode>,
);
