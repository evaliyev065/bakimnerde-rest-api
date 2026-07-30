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

## Taşeron kayıt akışı

- `POST /contractor-applications-create`: sözleşme onaylı public başvuru oluşturur.
- `GET /contractor-applications-list`: yalnız Bakımnerde ekibi başvuruları listeler.
- `POST /contractor-applications-approve`: başvurudan tenant, yönetici, profil ve cüzdan oluşturur.
- `POST /contractor-applications-reject`: zorunlu ret nedeniyle başvuruyu sonuçlandırır.

Production CORS allowlist’i admin paneli, Field Mobile App ve `https://contractor-registrations.bakimnerde.com` origin’lerini içermelidir.

## Saha Mobile App sözleşmesi

- `POST /auth-field-login`: yalnız `FIELD_WORKER` hesabına saha oturumu açar.
- `GET /field-workers-list`: Bakımnerde veya taşeron yönetimine uygun saha personeli dropdown verisini döndürür.
- `POST /jobs-field-worker-assign`: işi, atanmış taşeronun aktif saha personeline bağlar.
- `GET /jobs-list`: saha rolünde yalnız kullanıcıya atanmış işleri döndürür.
- `POST /job-field-report-get` ve `POST /job-field-report-save`: iş çevrimine bağlı saha formunu okur/kaydeder.
- `POST /job-evidence-list` ve `POST /job-evidence-add`: 6 önce, 6 sonra ve 1 markalı fotoğraf politikasını uygular.

Saha personeli ancak taşeron ataması onaylı ve randevu zamanı gelmiş işi başlatabilir. Bakımın tamamlanması için saha formu ile 13 fotoğraf kanıtının eksiksiz olması zorunludur.

Ekosistem dokümantasyonu: `../bakimnerde-docs/`  
API manuel test planı: `../bakimnerde-docs/docs/testing/MASTER_TEST_PLAN.md`
