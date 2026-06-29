import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'

const firebaseConfig = {
  apiKey: 'AIzaSyAavNdvbgXjK3lJn8CtDMQvdl9aOkUpTJk',
  authDomain: 'taher-ui-client.firebaseapp.com',
  projectId: 'taher-ui-client',
  storageBucket: 'taher-ui-client.firebasestorage.app',
  messagingSenderId: '409728077953',
  appId: '1:409728077953:web:0d25c5af5626e078d1fd80',
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
