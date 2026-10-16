import { storage } from './firebase.js';
import { ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';
// Tải ảnh avatar của người dùng lên Firebase Storage và trả về URL tải xuống.
export async function uploadAvatar(uid, file) {
  const storageRef = ref(storage, `avatars/${uid}/${file.name}`);
  const snapshot = await uploadBytes(storageRef, file);
  return getDownloadURL(snapshot.ref);
}



