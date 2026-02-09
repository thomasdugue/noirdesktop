// main.js - Le "cerveau" de l'application
// Ce fichier gère la fenêtre et les interactions avec macOS

const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

// Chemin du fichier de configuration
const configPath = path.join(app.getPath('userData'), 'config.json')

// Fonctions pour lire/écrire la config
function getConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }
  } catch (e) {}
  return {}
}

function saveConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

// Fonction qui crée la fenêtre principale
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0a', // Fond sombre
    titleBarStyle: 'hiddenInset', // Style macOS moderne
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  // Charge l'interface utilisateur
  mainWindow.loadFile('index.html')
}

// Quand l'app est prête, on crée la fenêtre
app.whenReady().then(() => {
  createWindow()

  // Sur macOS : recréer la fenêtre si on clique sur l'icône du dock
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// Quitter l'app quand toutes les fenêtres sont fermées (sauf sur macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Extensions audio supportées
const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.wav', '.aiff', '.aac', '.ogg', '.m4a', '.alac', '.wma']

// Quand l'interface demande d'ouvrir un dossier
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choisir un dossier de musique'
  })

  if (result.canceled) return null
  return result.filePaths[0]
})

// Scanne un dossier et retourne tous les fichiers audio
ipcMain.handle('scan-folder', async (event, folderPath) => {
  const audioFiles = []

  function scanDirectory(dirPath) {
    const items = fs.readdirSync(dirPath)

    for (const item of items) {
      const fullPath = path.join(dirPath, item)
      const stat = fs.statSync(fullPath)

      if (stat.isDirectory()) {
        // Sous-dossier : on scanne aussi
        scanDirectory(fullPath)
      } else {
        // Fichier : on vérifie si c'est de l'audio
        const ext = path.extname(item).toLowerCase()
        if (AUDIO_EXTENSIONS.includes(ext)) {
          audioFiles.push({
            name: path.basename(item, ext), // Nom sans extension
            path: fullPath,
            folder: path.basename(path.dirname(fullPath)) // Nom du dossier parent (souvent l'album)
          })
        }
      }
    }
  }

  scanDirectory(folderPath)
  return audioFiles
})

// Récupère les métadonnées d'un fichier audio (artiste, album, titre, etc.)
ipcMain.handle('get-metadata', async (event, filePath) => {
  try {
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(filePath)

    return {
      title: metadata.common.title || path.basename(filePath, path.extname(filePath)),
      artist: metadata.common.artist || 'Artiste inconnu',
      album: metadata.common.album || 'Album inconnu',
      track: metadata.common.track?.no || 0,
      year: metadata.common.year || null,
      duration: metadata.format.duration || 0,
      bitDepth: metadata.format.bitsPerSample || null,
      sampleRate: metadata.format.sampleRate || null,
      codec: metadata.format.codec || null
    }
  } catch (e) {
    return {
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Artiste inconnu',
      album: 'Album inconnu',
      track: 0,
      year: null,
      duration: 0,
      bitDepth: null,
      sampleRate: null,
      codec: null
    }
  }
})

// Ajoute un dossier à la liste des bibliothèques
ipcMain.handle('add-library-path', async (event, folderPath) => {
  const config = getConfig()
  // Initialise le tableau si nécessaire
  if (!Array.isArray(config.libraryPaths)) {
    config.libraryPaths = []
  }
  // Ajoute seulement si pas déjà présent
  if (!config.libraryPaths.includes(folderPath)) {
    config.libraryPaths.push(folderPath)
    saveConfig(config)
  }
  return true
})

// Récupère tous les chemins sauvegardés
ipcMain.handle('get-library-paths', async () => {
  const config = getConfig()
  return config.libraryPaths || []
})

// Récupère la pochette d'un fichier audio
ipcMain.handle('get-cover', async (event, filePath) => {
  try {
    // Import dynamique car music-metadata est un module ES
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(filePath)

    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const picture = metadata.common.picture[0]
      // Détermine le type MIME correct
      let mimeType = picture.format
      if (!mimeType || !mimeType.startsWith('image/')) {
        mimeType = 'image/jpeg' // Fallback
      }
      // Convertit en base64 pour l'afficher dans le HTML
      const base64 = Buffer.from(picture.data).toString('base64')
      return `data:${mimeType};base64,${base64}`
    }
  } catch (e) {
    console.log('Erreur lecture pochette:', e.message)
  }
  return null
})
