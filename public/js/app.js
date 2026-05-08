// Highlight the active nav link
document.querySelectorAll('.nav-link').forEach(link => {
  if (link.href === window.location.href) link.classList.add('active');
});

// Auto-select option card when radio changes (covers keyboard)
document.querySelectorAll('.option-card input[type=radio]').forEach(radio => {
  radio.addEventListener('change', () => {
    document.querySelectorAll('.option-card').forEach(c => c.classList.remove('selected'));
    radio.closest('.option-card')?.classList.add('selected');
  });
});
