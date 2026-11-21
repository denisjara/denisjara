import { createRoot } from 'react-dom/client';
import './fonts.css';
import './index.css';
import { App, ErrorBoundary } from './ui/App';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}
