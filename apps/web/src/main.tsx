import React from 'react';
import {createRoot} from 'react-dom/client';
import {ManualEditor} from './manual/ManualEditor';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ManualEditor/></React.StrictMode>);
