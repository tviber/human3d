import {createRoot} from 'react-dom/client';
import {App} from './lab/App';
import './tailwind.css';
import './style.css';
import './components/ui/ui.css';
import './theme/panels.css';
import './theme/scroll-regions.css';
createRoot(document.getElementById('root')!).render(<App/>);
