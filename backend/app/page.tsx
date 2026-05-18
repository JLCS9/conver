export default function Home() {
  return (
    <main style={{ padding: "3rem", maxWidth: 640, margin: "0 auto" }}>
      <h1 style={{ marginBottom: "0.5rem" }}>Converflow API</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        Backend service. There is no public web UI here.
      </p>
      <p>
        <a href="/api/health" style={{ color: "#0366d6" }}>
          /api/health
        </a>
      </p>
    </main>
  );
}
