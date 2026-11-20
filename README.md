# Houtan's Little Lab

A small playable introduction to Houtan's interests in games, learning, and learner modeling.

Open `index.html` in a modern browser. Keep the `assets` folder alongside it. The site uses plain HTML, CSS, and JavaScript with no build step or framework.

## Project files

- `index.html` contains the page structure.
- `styles/site.css` contains the page styling.
- `scripts/app.js` contains the page interactions.
- `scripts/hover-grid.js` contains the decorative pointer grid.
- `assets/` contains images and game art.

## Story experiences

The Story page has one carousel per category. Duplicate a `.small-card` inside the category's `.experience-track` to add an experience. The arrows loop through those cards. Replace an `.experience-slide` placeholder in `.experience-media` with an image (`<img src="assets/example.jpg" alt="Description">`) or video (`<video src="assets/example.mp4" controls playsinline></video>`). Add or remove `.experience-slide` elements to include more media for that experience.

The story, game, and synthesized sound effects work offline. Optional facial-expression models require an internet connection.
