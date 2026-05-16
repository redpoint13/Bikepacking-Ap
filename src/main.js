import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { renderApp } from './app.js';

// Mount the app shell
const container = document.getElementById('app');
if (!container) throw new Error('Root #app element not found');
renderApp(container);
