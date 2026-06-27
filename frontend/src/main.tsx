import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { initFixPrompt } from '@fixprompt/browser';
import App from './App';
import { FixPromptBoundary } from './components/FixPromptBoundary';
import './index.css';

const fpKey = import.meta.env.VITE_FIXPROMPT_KEY as string | undefined;
if (fpKey) {
  initFixPrompt({
    projectKey: fpKey,
    source: 'sigcore-frontend-prod',
    service: 'sigcore-frontend',
    env: import.meta.env.PROD ? 'prod' : 'dev',
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FixPromptBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </FixPromptBoundary>
  </React.StrictMode>,
);
