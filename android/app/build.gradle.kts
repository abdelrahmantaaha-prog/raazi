import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The release key lives in android/.signing/ (kept out of git). Without it the
// release build is left unsigned and the debug build is what gets installed.
val signing = Properties().apply {
    val file = rootProject.file(".signing/keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.lymoon.raazi"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.lymoon.raazi"
        // Android 10. Below it, saving an export into Downloads needs a storage
        // permission, and asking for one on a LAN viewer is a poor trade for
        // devices that are essentially extinct.
        minSdk = 29
        targetSdk = 35
        versionCode = 2
        versionName = "2.0"
    }

    signingConfigs {
        if (signing.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(".signing/" + signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // The pairing code on the computer's Settings page. Google's scanner needs
    // no camera permission (it runs in Play services); on a phone without Play
    // services the token can still be pasted.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
