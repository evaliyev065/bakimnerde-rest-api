# MongoDB kurulumu

Yerel MongoDB çalışırken:

```powershell
npm.cmd run db:setup
```

Farklı bağlantı için:

```powershell
$env:MONGODB_URI="mongodb://kullanici:parola@sunucu:27017"
$env:MONGODB_DATABASE="bakimnerde"
$env:DB_SEED_PASSWORD="Guclu-Test-Parolasi"
npm.cmd run db:setup
```

Komut idempotenttir; 3+1 rol modelini, koleksiyonları ve indexleri kurar. Eski üretici rolü/tenantı yeni iş kurallarında bulunmadığı için temizlenir; diğer operasyon verileri korunur.

Örnek girişler:

- Bakımnerde özel kanal: `admin@bakimnerde.com`
- CPO şirket kanalı: `operasyon@voltgo.test`
- Taşeron yönetimi: `yonetici@marmarateknik.test`
- Mobil saha kanalı: `saha@marmarateknik.test`

Tüm örnek hesapların parolası `Bakimnerde!2026` değeridir.
