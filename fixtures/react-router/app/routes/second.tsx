// The page the home route links to. Its button's click takes 60 ms, so it is reported.
export default function Second() {
  return (
    <main>
      <h1>Second page</h1>
      <button
        type="button"
        onClick={() => {
          const end = performance.now() + 60;
          while (performance.now() < end) {}
        }}
      >
        Slow
      </button>
    </main>
  );
}
