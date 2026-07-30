# Postman kullanımı

1. `Bakimnerde-REST-API.postman_collection.json` dosyasını içe aktarın.
2. `Bakimnerde-Local.postman_environment.json` ortamını içe aktarın ve seçin.
3. API'yi `npm.cmd run dev` ile çalıştırın.
4. Koleksiyonu Collection Runner ile klasör sırasına göre çalıştırın.

Koleksiyon dört giriş kanalını ve oluşturduğu kayıt kimliklerini otomatik yönetir. `03 · CPO → Bakımnerde → Taşeron Akışı` klasörü native Mobile App ve PWA 2.0'ın kullandığı İngilizce API yollarını da doğrular: cihaz-istasyon eşlemesi, bağlı cihaz sayılı istasyon listesi, cihaz bakım geçmişi, DB iş sayısı, saha ataması, base64 medya round-trip'i, fiyatsız ek tedarik girdisi, iş sohbeti ve kalıcı okunmamış bildirim.

Mobile App yazma örneklerinde `X-API-Version`, `Idempotency-Key` ve aynı değeri taşıyan `clientOperationId` bulunur. Böylece offline outbox'ın yeniden gönderim sözleşmesi Postman ile de tekrarlanabilir. CRUD kayıtları test sonunda temizlenir; yalnız cüzdan denetimi için 1 TL'lik izlenebilir bir test hareketi bırakır.
