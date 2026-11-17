import './styles.css';
import { createUi } from './ui';

const root = document.querySelector<HTMLElement>('#app');
if (!root) {
  throw new Error('#app root element not found');
}
createUi(root);
