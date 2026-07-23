# Bakımnerde REST API

Bakımnerde ekosisteminin bağımsız Express + TypeScript servisidir. Kod, özellik odaklı modüller içinde `application`, `domain`, `infrastructure` ve `presentation` sınırlarına ayrılır; composition root `src/bootstrap` altındadır.

## Hızlı başlangıç

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run dev
```

Kalite kapısı:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Health endpoint'leri `GET /health-live` ve `GET /health-ready` adreslerindedir. İş endpoint'leri tek statik `kebab-case` segment ve `POST` sözleşmesini kullanır.

Ekosistem dokümantasyonu: `../bakimnerde-docs/`  
API manuel test planı: `../bakimnerde-docs/docs/testing/MASTER_TEST_PLAN.md`

