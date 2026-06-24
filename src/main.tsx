import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { CoverageStudy } from './components/validation/CoverageStudy';
import { WinRateStudy } from './components/validation/WinRateStudy';
import './index.css';

// Validation studies mount as standalone entries, bypassing the interview app's
// phase machine entirely. ?study=coverage → coverage allocation; ?study=winrate
// → matched-pair preference.
const study = new URLSearchParams(window.location.search).get('study');
const Root =
  study === 'coverage'
    ? CoverageStudy
    : study === 'winrate'
      ? WinRateStudy
      : App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
