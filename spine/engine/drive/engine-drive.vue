<template>
  <div class="engine-drive-container">
    <header class="drive-header">
      <h2>🚀 Cybernetic Drive Module</h2>
      <p class="subtitle">Session Management & Rate-Policy Enforcer</p>
    </header>

    <main class="drive-dashboard">
      <section class="card read-ops">
        <h3>📡 Read Operations</h3>
        <p>Active crawlers gathering acquisition data.</p>
        <div class="status-indicator" :class="{ active: isReading }">
          {{ isReading ? 'Gathering Data...' : 'Idle' }}
        </div>
        <button @click="toggleRead" class="action-btn">
          {{ isReading ? 'Stop Read' : 'Start Read' }}
        </button>
      </section>

      <section class="card write-ops">
        <h3>✍️ Write Operations</h3>
        <p>Managing and updating our listings (Sale).</p>
        <div class="status-indicator" :class="{ active: isWriting }">
          {{ isWriting ? 'Updating...' : 'Idle' }}
        </div>
        <button @click="toggleWrite" class="action-btn">
          {{ isWriting ? 'Stop Write' : 'Start Write' }}
        </button>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const isReading = ref(false);
const isWriting = ref(false);

const toggleRead = () => {
  isReading.value = !isReading.value;
};

const toggleWrite = () => {
  isWriting.value = !isWriting.value;
};
</script>

<style scoped>
.engine-drive-container {
  font-family: 'Inter', sans-serif;
  padding: 2rem;
  background: #0f172a;
  color: #f8fafc;
  min-height: 100vh;
}
.drive-header {
  margin-bottom: 2rem;
  text-align: center;
}
.drive-header h2 {
  font-size: 2.5rem;
  background: linear-gradient(90deg, #38bdf8, #818cf8);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.subtitle {
  color: #94a3b8;
}
.drive-dashboard {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1.5rem;
}
.card {
  background: #1e293b;
  border-radius: 12px;
  padding: 1.5rem;
  box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);
  transition: transform 0.2s, box-shadow 0.2s;
}
.card:hover {
  transform: translateY(-5px);
  box-shadow: 0 20px 25px -5px rgba(0,0,0,0.2);
}
.status-indicator {
  margin: 1rem 0;
  padding: 0.5rem 1rem;
  border-radius: 9999px;
  font-weight: bold;
  text-align: center;
  background: #334155;
  color: #cbd5e1;
}
.status-indicator.active {
  background: rgba(16, 185, 129, 0.2);
  color: #10b981;
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.5);
}
.action-btn {
  width: 100%;
  padding: 0.75rem;
  border: none;
  border-radius: 8px;
  font-weight: bold;
  cursor: pointer;
  background: #3b82f6;
  color: white;
  transition: background 0.2s;
}
.action-btn:hover {
  background: #2563eb;
}
</style>
