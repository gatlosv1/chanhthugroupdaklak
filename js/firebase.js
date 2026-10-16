import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-analytics.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';
import { getDatabase } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js';

const defaultAuthDomain = 'quanlynlchanhthu.firebaseapp.com';
const currentHostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const isLocalHost = currentHostname === 'localhost' || currentHostname === '127.0.0.1' || currentHostname === '0.0.0.0';
const authDomain = isLocalHost ? currentHostname : defaultAuthDomain;

const firebaseConfig = {
  apiKey: 'AIzaSyAFQQ5yvXsA5B3etXDM_k0g6-HcEjDEpGo',
  authDomain,
  projectId: 'quanlynlchanhthu',
  storageBucket: 'quanlynlchanhthu.firebasestorage.app',
  messagingSenderId: '776184745772',
  appId: '1:776184745772:web:1e6a3ffc99fe6fe4ee6689',
  databaseURL: 'https://quanlynlchanhthu-default-rtdb.asia-southeast1.firebasedatabase.app',
  measurementId: 'G-8S9RBYFG40'
};

let app;
let analytics = null;
let auth;
let db;
let storage;
let rtdb;

// Khởi tạo Firebase và các dịch vụ liên quan
// Nếu lỗi thì dùng lại app đã có sẵn
try {
  app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  analytics = typeof window !== 'undefined' && typeof window.gtag !== 'undefined' ? getAnalytics(app) : null;
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  rtdb = getDatabase(app);
} catch (error) {
  console.warn('Firebase initialization warning:', error);
  app = getApps()[0] || null;
  auth = app ? getAuth(app) : null;
  db = app ? getFirestore(app) : null;
  storage = app ? getStorage(app) : null;
  rtdb = app ? getDatabase(app) : null;
}

export { app, analytics, auth, db, storage, rtdb, firebaseConfig };
export default app;



