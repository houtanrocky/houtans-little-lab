(() => {
    const root = document.documentElement;
    let lastX = -1, lastY = -1;
    let lastColor = '';
    const cellColors = ['#ffd15c', '#ff947e', '#9fe4f1', '#b7ebc3', '#c7b7ff'];
    function updateHoveredCell(event) {
     if (event.pointerType === 'touch') return;
     const cellWidth = parseFloat(getComputedStyle(root).getPropertyValue('--grid-cell-w')) || 96;
     const cellHeight = parseFloat(getComputedStyle(root).getPropertyValue('--grid-cell-h')) || 74;
     const x = Math.floor(event.clientX / cellWidth) * cellWidth;
     const y = Math.floor(event.clientY / cellHeight) * cellHeight;
     if (x === lastX && y === lastY) return;
     lastX = x;
     lastY = y;
     root.style.setProperty('--hover-cell-x', x + 'px');
     root.style.setProperty('--hover-cell-y', y + 'px');
     const choices = cellColors.filter(color => color !== lastColor);
     lastColor = choices[Math.floor(Math.random() * choices.length)];
     root.style.setProperty('--hover-cell-color', lastColor);
     document.body.classList.add('has-grid-hover');
    }
    window.addEventListener('pointermove', updateHoveredCell, { passive:true });
    window.addEventListener('pointerleave', () => document.body.classList.remove('has-grid-hover'));
    window.addEventListener('blur', () => document.body.classList.remove('has-grid-hover'));
   })();