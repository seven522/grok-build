try {
  document.documentElement.dataset.theme = localStorage.getItem('stillpoint-color-scheme') === 'dark' ? 'dark' : 'light'
} catch {
  document.documentElement.dataset.theme = 'light'
}
