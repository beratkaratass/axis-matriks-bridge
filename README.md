# Axis Matriks Bridge

Windows bridge between MatriksIQ and an Axis server. It reports market/account
state, supports active/standby failover, and can submit guarded Zirve orders.

## Requirements

- Windows 10 or newer
- Node.js 22 or newer
- MatriksIQ with the external order API licence when order submission is needed

## Install

1. Download `Axis-Matriks-Windows.zip` from the latest GitHub release.
2. Extract it to `C:\Axis-Matriks`.
3. Run `local-windows\Kurulum.cmd` and enter the Axis server URL and agent token.
4. Start MatriksIQ and use the **Axis Matriks** desktop shortcut.

The installer creates `.env.matriks` locally. That file contains the device
token and is intentionally excluded from Git.

Real orders are disabled by default. Enabling them requires
`MATRIKS_REAL_TRADING=1` on that PC, an exact VIOP account selection on Axis,
and the confirmation phrase shown by Axis.

## Update

When Axis advertises a newer release, the Windows UI enables **Guncelle**. The
updater downloads the release ZIP over HTTPS, verifies its SHA-256 checksum,
replaces only application files, preserves `.env.matriks`, and restarts the
bridge.
