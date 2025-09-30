
# Changelog

## v014g-ws
- Modern (Laptop/Chrome/Edge): **WebSocket H.264 + WebCodecs** → autoplay tanpa klik
- NetCast (Chrome 47/SRAF): tetap **Legacy MP4**, perbaikan **grid selector** kompatibel (tanpa classList.toggle)
- Preset: dropdown global + tombol cepat per-kamera (cycle Low/Balanced/High)
- **Status FFmpeg per kamera** di UI (legacy running, ws running, clients, ukuran file)

## v014g-ws-fix1
- **Fix startup crash (Node v18):** perbaiki RegExp pada upgrade handler menjadi `/^\/ws\/([^\/]+)$/`.
- **Bump version** ke `0.14.7-fix1` (tidak mengubah fitur).
