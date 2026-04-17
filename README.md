# 🎭 VRM Multi-Format Animation Player PRO

A high-performance, professional browser-based 3D character animation player. Built with Three.js, it supports **VRM**, **MMD (PMX/PMD)**, **FBX**, and **glTF** models with advanced animation retargeting and expressions.

![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-lightgrey.svg)
![Version](https://img.shields.io/badge/version-1.1.0-green.svg)
![Three.js](https://img.shields.io/badge/Three.js-r169-black.svg)

## 🚀 Live Demo
**View the official deployment here:** [https://vrm-loader.vercel.app/](https://vrm-loader.vercel.app/)

## ✨ Key Features

- **Multi-Format Support**: Load VRM, PMX, PMD, FBX, and GLB/GLTF characters.
- **Universal Animation**: Seamlessly play `.vmd`, `.vrma`, and `.fbx` animations on any character.
- **Premium Visuals**: 
  - **4x MSAA + FXAA** for crisp, smooth edges.
  - **Subtle ambient lighting** for natural character presentation.
  - **Glassmorphism UI** for a modern, sleek experience.
- **Advanced Controls**:
  - Full expression sliders (Happy, Sad, Angry, etc.).
  - Interactive Eye Tracking (toggled).
  - Animation persistence (swap models without losing your current animation).
- **Physics Stabilization**: Delta-time clamping ensures smooth hair and cloth physics even during frame drops.

## ⚠️ Not for Mobile

**This application is designed for desktop browsers only.**

- ❌ **Mobile browsers NOT supported** - Complex 3D rendering, file loading, and UI interactions require desktop capabilities
- ✅ **Desktop browsers** - Chrome, Firefox, Edge recommended
- 💻 **Minimum 4GB RAM** recommended for smooth 3D model loading

##  Local Development

### 1. Prerequisites
- [Node.js](https://nodejs.org/) installed on your system.

### 2. Setup
Clone the repository:
```bash
git clone https://github.com/kuma-sannn/vrm-loader.git
cd vrm-loader
```

### 3. Run Locally
```bash
npm run dev
# or
node server.js
```
Then open `http://localhost:8000`.

## 🛠️ Built With
- **Three.js**: Core 3D engine.
- **@pixiv/three-vrm**: VRM format support.
- **three-mmd-loader**: MMD (VMD/PMX) support.
- **Vanilla CSS**: Premium Glassmorphism UI.

## 📄 License

**Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**

[![License: CC BY-NC 4.0](https://licensebuttons.net/l/by-nc/4.0/88x31.png)](https://creativecommons.org/licenses/by-nc/4.0/)

You are free to:
- **Share** — copy and redistribute the material in any medium or format
- **Adapt** — remix, transform, and build upon the material

Under the following terms:
- **Attribution** — You must give appropriate credit
- **NonCommercial** — You may **NOT** use the material for commercial purposes

See [LICENSE](LICENSE) for full details.
