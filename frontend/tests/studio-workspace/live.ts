// Actual UI against isolated Core/Bridge/BFF. No API mock or interceptor.
import { createApp } from 'vue'
import VideoStudioView from '@/views/user/VideoStudioView.vue'
import '@/style.css'
import '@/styles/site-theme.css'
createApp(VideoStudioView).mount('#app')
