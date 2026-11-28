import { initSiteAnalytics } from './analytics';

const page = document.body.dataset.legalPage;
if (page === 'privacy' || page === 'terms') initSiteAnalytics(page);
