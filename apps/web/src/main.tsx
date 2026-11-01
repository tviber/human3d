import {createRoot} from 'react-dom/client';
import {App} from './lab/App';
import './style.css';
import './components/ui/ui.css';
import './layout/panels.css';
import './layout/scroll-regions.css';
import './redesign.css';
createRoot(document.getElementById('root')!).render(<App/>);
